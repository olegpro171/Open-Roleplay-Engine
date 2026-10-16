import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { z, ZodError } from 'zod';
import { existsSync } from 'node:fs';
import type { ServerOptions } from 'node:https';
import { AppError } from '../core/errors.js';
import { assembleRequest } from '../core/prompt.js';
import { Store } from '../persistence/store.js';
import { OpenAICompatibleProvider, type Provider } from '../provider/openai.js';
import { editSchema, passwordSchema, retrySchema, revisionSchema, saveSettingsSchema, submissionSchema } from '../shared/contracts.js';
import { Auth, sessionSeconds } from './auth.js';
import { GenerationCoordinator } from './coordinator.js';

export async function createApp(options: {
  database: string; staticDirectory?: string; migrationsDirectory?: string;
  provider?: Provider; https?: ServerOptions;
}) {
  const store = new Store(options.database, options.migrationsDirectory);
  const coordinator = new GenerationCoordinator(store, options.provider ?? new OpenAICompatibleProvider());
  const auth = new Auth(store);
  const secure = Boolean(options.https);
  const app = Fastify({ logger: false, bodyLimit: 1_000_000, ...(options.https ? { https: options.https } : {}) });
  await app.register(cookie);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const hostname = request.hostname;
    if (!secure && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
      throw new AppError(403, 'https_required', 'LAN access requires HTTPS. Open the local address on the Mac.');
    }
    if (!request.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(request.method)) {
      const expectedOrigin = `${secure ? 'https' : 'http'}://${request.host}`;
      if (request.headers.origin !== expectedOrigin || !request.headers['content-type']?.startsWith('application/json')) {
        throw new AppError(403, 'invalid_origin', 'Commands must come from this application with a JSON body.');
      }
    }
    if (!['/api/session', '/api/setup', '/api/login'].includes(request.url.split('?')[0]) && !auth.authenticated(request.cookies.session)) {
      throw new AppError(401, 'login_required', 'Sign in to continue.');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.status).send({ code: error.code, message: error.message });
    if (error instanceof ZodError) return reply.code(400).send({ code: 'invalid_input', message: error.issues.map((issue) => `${issue.path.join('.') || 'Input'}: ${issue.message}`).join('; ') });
    const status = (error as { statusCode?: number }).statusCode;
    return reply.code(status && status < 500 ? status : 500).send({ code: 'request_failed', message: 'The request could not be completed.' });
  });
  const setSession = (reply: { setCookie: (name: string, token: string, options: object) => unknown }, token: string) => {
    reply.setCookie('session', token, { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge: sessionSeconds });
  };
  app.get('/api/session', async (request) => ({ setupRequired: auth.setupRequired(), authenticated: auth.authenticated(request.cookies.session) }));
  app.post('/api/setup', async (request, reply) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) throw new AppError(403, 'local_setup_only', 'Create the owner account from the Mac first.');
    const { password } = passwordSchema.parse(request.body);
    setSession(reply, await auth.setup(password));
    return { ok: true };
  });
  app.post('/api/login', async (request, reply) => {
    const { password } = passwordSchema.parse(request.body);
    setSession(reply, await auth.login(password, request.ip));
    return { ok: true };
  });
  app.post('/api/logout', async (request, reply) => {
    auth.logout(request.cookies.session);
    reply.clearCookie('session', { path: '/', secure, sameSite: 'strict' });
    coordinator.changed();
    return { ok: true };
  });

  app.get('/api/chat', async () => store.snapshot());
  app.put('/api/settings', async (request) => {
    const input = saveSettingsSchema.parse(request.body);
    store.saveSettings(input.revision, input.connection, input.settings, input.apiKey);
    coordinator.changed();
    return store.snapshot();
  });
  app.post('/api/preview', async (request) => {
    const input = z.object({ revision: revisionSchema, text: z.string().max(100_000).optional() }).strict().parse(request.body);
    const snapshot = store.snapshot();
    if (snapshot.revision !== input.revision) throw new AppError(409, 'revision_conflict', 'The chat changed. Refresh the preview.');
    if (!snapshot.connection) throw new AppError(422, 'connection_required', 'Save a Connection first.');
    const turns = [...snapshot.turns];
    if (input.text !== undefined && input.text !== '') {
      if (turns.at(-1)?.complete === false) throw new AppError(409, 'pending_turn', 'Resolve the pending turn before previewing a new one.');
      turns.push({ id: 'draft', position: (turns.at(-1)?.position ?? 0) + 1, complete: false, user: { id: 'draft-user', revision: 0, text: input.text }, assistant: { id: 'draft-assistant', revision: 0, text: '' } });
    }
    return assembleRequest(snapshot.connection, snapshot.settings, turns);
  });
  app.post('/api/turns', async (request, reply) => {
    const input = submissionSchema.parse(request.body);
    return reply.code(202).send(coordinator.start(input.revision, input.requestId, input.text));
  });
  app.post('/api/retry', async (request, reply) => {
    const input = retrySchema.parse(request.body);
    return reply.code(202).send(coordinator.start(input.revision, input.requestId));
  });
  app.post('/api/generations/:id/cancel', async (request) => {
    z.object({}).strict().parse(request.body);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    coordinator.cancel(id);
    return store.snapshot();
  });
  app.patch('/api/turns/:id/:part', async (request) => {
    const { id, part } = z.object({ id: z.string().uuid(), part: z.enum(['user', 'assistant']) }).parse(request.params);
    const input = editSchema.parse(request.body);
    store.editPart(input.revision, id, part, input.text);
    coordinator.changed();
    return store.snapshot();
  });
  app.delete('/api/turns/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { revision } = z.object({ revision: revisionSchema }).strict().parse(request.body);
    store.deleteTurn(revision, id);
    coordinator.changed();
    return store.snapshot();
  });
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const changed = () => {
      if (!auth.authenticated(request.cookies.session)) { reply.raw.end(); return; }
      if (!reply.raw.destroyed) reply.raw.write('data: {}\n\n');
    };
    const shutdown = () => reply.raw.end();
    const ping = setInterval(changed, 15_000);
    coordinator.events.on('changed', changed);
    coordinator.events.on('shutdown', shutdown);
    reply.raw.on('close', () => {
      clearInterval(ping);
      coordinator.events.off('changed', changed);
      coordinator.events.off('shutdown', shutdown);
    });
    changed();
  });
  if (options.staticDirectory && existsSync(options.staticDirectory)) {
    await app.register(staticFiles, { root: options.staticDirectory });
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ message: 'Not found.' }) : reply.sendFile('index.html'));
  }
  app.addHook('preClose', async () => coordinator.shutdown());
  app.addHook('onClose', async () => store.close());
  return { app, store, coordinator };
}
