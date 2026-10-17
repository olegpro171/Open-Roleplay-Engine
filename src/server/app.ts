import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { z, ZodError } from 'zod';
import { existsSync } from 'node:fs';
import type { ServerOptions } from 'node:https';
import { importCharacter, importPersonas, exportCharacter, exportPersona } from '../core/cards.js';
import { defaultPrompt, libraryCommandSchema, selectionsSchema, replaceHistorySchema } from '../shared/library.js';
import { readCardFile } from './card-import.js';
import { AppError } from '../core/errors.js';
import { assembleRequest } from '../core/prompt.js';
import { Store } from '../persistence/store.js';
import { fetchModels, OpenAICompatibleProvider, type Provider } from '../provider/openai.js';
import { connectionSchema, editSchema, passwordSchema, retrySchema, revisionSchema, saveSettingsSchema, submissionSchema } from '../shared/contracts.js';
import { trimBoundaryNewlines } from '../shared/text.js';
import { Auth, sessionSeconds } from './auth.js';
import { GenerationCoordinator } from './coordinator.js';
import { contextPlan } from '../core/context-plan.js';

export async function createApp(options: {
  database: string; staticDirectory?: string; migrationsDirectory?: string;
  provider?: Provider; https?: ServerOptions;
}) {
  const store = new Store(options.database, options.migrationsDirectory);
  const provider = options.provider ?? new OpenAICompatibleProvider();
  const coordinator = new GenerationCoordinator(store, provider);
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
      throw new AppError(403, 'https_required', 'LAN access requires HTTPS. Open the local address on the server computer.');
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
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) throw new AppError(403, 'local_setup_only', 'Create the owner account from the server computer first.');
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

  const identity = z.string().min(1).max(100);
  const chatId = (params: unknown) => z.object({ chatId: identity.optional() }).parse(params ?? {}).chatId ?? 'main';
  const connectionKey = (input: { endpoint: string; connectionId?: string; apiKey?: string }) => {
    if (input.apiKey !== undefined) return input.apiKey;
    if (!input.connectionId) return '';
    const savedKey = store.connectionApiKey(input.connectionId);
    if (!savedKey) return '';
    const saved = store.libraries().connections.find(connection => connection.id === input.connectionId);
    if (!saved || saved.endpoint.replace(/\/+$/, '') !== input.endpoint.replace(/\/+$/, '')) throw new AppError(422, 'saved_key_endpoint_changed', 'Enter an API key for the changed endpoint. The saved key is only used with its saved API base URL.');
    return savedKey;
  };
  app.post('/api/models', async request => {
    const input = z.object({ endpoint: connectionSchema.shape.endpoint, connectionId: identity.optional(), apiKey: saveSettingsSchema.shape.apiKey }).strict().parse(request.body);
    return { models: await fetchModels(input.endpoint, connectionKey(input)) };
  });
  app.post('/api/connections/diagnose', async request => {
    const input = z.object({ action: z.enum(['check', 'test']), connection: connectionSchema, connectionId: identity.optional(), apiKey: saveSettingsSchema.shape.apiKey }).strict().parse(request.body);
    const apiKey = connectionKey({ ...input, endpoint: input.connection.endpoint });
    if (input.action === 'check') {
      const models = await fetchModels(input.connection.endpoint, apiKey);
      return { message: `The endpoint accepted the connection check${apiKey ? '' : ' without an API key'}. ${models.includes(input.connection.model) ? 'The selected model is listed.' : 'The selected model was not listed; generation access is unverified.'}` };
    }
    const connection = { ...input.connection, maxOutputTokens: Math.min(64, input.connection.maxOutputTokens) };
    const preview = assembleRequest(connection, { title: 'Connection test', instructions: '', character: '', persona: '', targetInputTokens: connection.contextWindow - connection.maxOutputTokens }, [{ id: 'test', position: 1, complete: false, user: { id: 'test-user', revision: 0, text: 'Hi' }, assistant: { id: 'test-assistant', revision: 0, text: '' } }]);
    let response = '';
    const completion = await provider.stream(preview, apiKey, AbortSignal.timeout(30_000), text => { response += text; });
    return { message: 'Test completed.', request: preview, response, usage: completion?.usage ?? null };
  });
  app.get('/api/library', async () => store.libraries());
  app.post('/api/library', { bodyLimit: 3_000_000 }, async request => {
    const input = libraryCommandSchema.parse(request.body);
    const id = store.saveLibrary(input.revision, input.kind, input.data, undefined, input.kind === 'connections' ? input.apiKey : undefined);
    coordinator.changed(); return { id };
  });
  app.put('/api/library/:id', { bodyLimit: 3_000_000 }, async request => {
    const { id } = z.object({ id: identity }).parse(request.params);
    const input = libraryCommandSchema.parse(request.body);
    store.saveLibrary(input.revision, input.kind, input.data, id, input.kind === 'connections' ? input.apiKey : undefined);
    coordinator.changed(); return { id };
  });
  app.delete('/api/library/:id', async request => {
    const { id } = z.object({ id: identity }).parse(request.params);
    const input = z.object({ revision: revisionSchema, kind: z.enum(['personas', 'characters', 'prompts', 'connections', 'contexts']) }).strict().parse(request.body);
    store.deleteLibrary(input.revision, input.kind, id); coordinator.changed(); return { ok: true };
  });
  app.post('/api/library/default/restore', async request => {
    const { revision } = z.object({ revision: revisionSchema }).strict().parse(request.body);
    store.saveLibrary(revision, 'prompts', defaultPrompt, 'default'); coordinator.changed(); return { ok: true };
  });
  app.post('/api/library/import', { bodyLimit: 3_000_000 }, async request => {
    const input = z.object({ revision: revisionSchema, kind: z.enum(['personas', 'characters']), base64: z.string().max(2_700_000) }).strict().parse(request.body);
    const value = readCardFile(input.base64);
    let items;
    try { items = input.kind === 'characters' ? [importCharacter(value)] : importPersonas(value); }
    catch (error) { if (error instanceof ZodError) throw error; throw new AppError(400, 'invalid_card', error instanceof Error ? error.message : 'Invalid card.'); }
    const ids = store.importLibrary(input.revision, input.kind, items); coordinator.changed(); return { ids };
  });
  app.get('/api/library/:kind/:id/export', async request => {
    const { kind, id } = z.object({ kind: z.enum(['personas', 'characters', 'prompts', 'contexts']), id: identity }).parse(request.params);
    const item = store.libraries()[kind].find(item => item.id === id);
    if (!item) throw new AppError(404, 'item_not_found', 'Library item not found.');
    const { id: _id, revision: _revision, ...data } = item;
    if (kind === 'characters') return exportCharacter(data as Parameters<typeof exportCharacter>[0]);
    if (kind === 'personas') return exportPersona(data as Parameters<typeof exportPersona>[0]);
    return data;
  });
  app.post('/api/chats', async request => {
    const input = selectionsSchema.parse(request.body);
    const id = store.createChat(input); coordinator.changed(); return { id };
  });
  app.put('/api/chats/:chatId/selections', async request => {
    const input = z.object({ revision: revisionSchema, settings: selectionsSchema }).strict().parse(request.body);
    store.updateChat(input.revision, chatId(request.params), input.settings); coordinator.changed(); return store.snapshot(chatId(request.params));
  });
  app.delete('/api/chats/:chatId', async request => {
    const { revision } = z.object({ revision: revisionSchema }).strict().parse(request.body);
    store.deleteChat(revision, chatId(request.params)); coordinator.changed(); return { ok: true };
  });
  app.put('/api/chats/:chatId/history', { bodyLimit: 25_000_000 }, async request => {
    const input = replaceHistorySchema.parse(request.body);
    store.replaceHistory(input.revision, chatId(request.params), input.turns); coordinator.changed(); return { ok: true };
  });
  app.get('/api/chats/:chatId/context/plan', async request => contextPlan(store.snapshot(chatId(request.params))));
  app.post('/api/chats/:chatId/context/prepare', async (request, reply) => {
    const input = z.object({ revision: revisionSchema, requestId: z.string().uuid(), mode: z.enum(['prepare', 'step', 'repair']) }).strict().parse(request.body);
    return reply.code(202).send(coordinator.context.start(chatId(request.params), input.revision, input.requestId, input.mode));
  });
  app.post('/api/chats/:chatId/context/clear', async request => {
    const { revision } = z.object({ revision: revisionSchema }).strict().parse(request.body);
    store.contexts.clearMemory(chatId(request.params), revision); coordinator.changed(); return { ok: true };
  });
  app.post('/api/chats/:chatId/context/refresh', async request => {
    const input = z.object({ revision: revisionSchema, requestId: z.string().uuid() }).strict().parse(request.body);
    const result = store.contexts.refresh(chatId(request.params), input.revision, input.requestId);
    coordinator.changed(); return result;
  });
  app.patch('/api/chats/:chatId/context/summaries/:id', { bodyLimit: 1_100_000 }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({ revision: revisionSchema, summaryRevision: revisionSchema, text: z.string().max(1_000_000) }).strict().parse(request.body);
    const ref = store.contexts.editSummary(chatId(request.params), input.revision, { id, revision: input.summaryRevision }, input.text);
    coordinator.changed(); return ref;
  });
  app.get('/api/context/jobs/:id', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return { job: store.contexts.job(id), steps: store.contexts.steps(id) };
  });
  app.post('/api/context/jobs/:id/cancel', async request => {
    z.object({}).strict().parse(request.body);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    coordinator.context.cancel(id); return { ok: true };
  });
  app.post('/api/context/jobs/:id/review', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({ revision: revisionSchema, accept: z.boolean(), text: z.string().max(1_000_000).optional() }).strict().parse(request.body);
    store.contexts.review(id, input.revision, input.accept, input.text); coordinator.changed(); return { ok: true };
  });
  for (const prefix of ['/api', '/api/chats/:chatId']) {
    app.get(prefix + (prefix === '/api' ? '/chat' : ''), async request => store.snapshot(chatId(request.params)));
    app.put(prefix + '/settings', async request => {
      const input = saveSettingsSchema.parse(request.body);
      store.saveSettings(input.revision, input.connection, input.settings, input.apiKey, chatId(request.params));
      coordinator.changed(); return store.snapshot(chatId(request.params));
    });
    app.post(prefix + '/preview', async request => {
      const input = z.object({ revision: revisionSchema, text: z.string().max(100_000).optional(), inspection: z.boolean().optional() }).strict().parse(request.body);
      if (input.text !== undefined) input.text = trimBoundaryNewlines(input.text);
      const snapshot = store.snapshot(chatId(request.params));
      if (snapshot.revision !== input.revision) throw new AppError(409, 'revision_conflict', 'The chat changed. Refresh the preview.');
      if (!snapshot.connection) throw new AppError(422, 'connection_required', 'Save a Connection first.');
      const turns = [...snapshot.turns];
      if (input.text !== undefined && input.text !== '') {
        if (turns.at(-1)?.complete === false) throw new AppError(409, 'pending_turn', 'Resolve the pending turn before previewing a new one.');
        turns.push({ id: 'draft', position: (turns.at(-1)?.position ?? 0) + 1, complete: false, user: { id: 'draft-user', revision: 0, text: input.text }, assistant: { id: 'draft-assistant', revision: 0, text: '' } });
      }
      return assembleRequest(snapshot.connection, snapshot.settings, turns, snapshot.sources, snapshot.context, input.inspection ? { validateLimits: false, allowStale: true } : {});
    });
    app.post(prefix + '/turns', async (request, reply) => {
      const input = submissionSchema.parse(request.body);
      return reply.code(202).send(coordinator.start(input.revision, input.requestId, input.text, chatId(request.params)));
    });
    app.post(prefix + '/retry', async (request, reply) => {
      const input = retrySchema.parse(request.body);
      return reply.code(202).send(coordinator.start(input.revision, input.requestId, undefined, chatId(request.params)));
    });
    app.patch(prefix + '/turns/:id/:part', async request => {
      const { id, part } = z.object({ id: z.string().uuid(), part: z.enum(['user', 'assistant']) }).parse(request.params);
      const input = editSchema.parse(request.body);
      store.editPart(input.revision, id, part, input.text, chatId(request.params)); coordinator.changed(); return store.snapshot(chatId(request.params));
    });
    app.delete(prefix + '/turns/:id', async request => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { revision } = z.object({ revision: revisionSchema }).strict().parse(request.body);
      store.deleteTurn(revision, id, chatId(request.params)); coordinator.changed(); return store.snapshot(chatId(request.params));
    });
  }
  app.post('/api/generations/:id/cancel', async request => {
    z.object({}).strict().parse(request.body);
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    coordinator.cancel(id); return { ok: true };
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
