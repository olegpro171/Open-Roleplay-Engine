import Fastify, { type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { z, ZodError } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ServerOptions } from 'node:https';
import { importPersonas, exportCharacter, exportPersona } from '../core/cards.js';
import { tagIdsSchema, tagNameSchema, tagPolicySchema } from '../shared/tags.js';
import { defaultPrompt, libraryCommandSchema, selectionsSchema, replaceHistorySchema } from '../shared/library.js';
import { readCardFile } from './card-import.js';
import { AppError } from '../core/errors.js';
import { assembleRequest } from '../core/prompt.js';
import { Store } from '../persistence/store.js';
import { fetchModels, OpenAICompatibleProvider, type Provider } from '../provider/openai.js';
import { connectionSchema, editSchema, passwordSchema, retrySchema, revisionSchema, saveSettingsSchema, submissionSchema, type ChatSnapshot } from '../shared/contracts.js';
import { trimBoundaryNewlines } from '../shared/text.js';
import { Auth, sessionSeconds } from './auth.js';
import { GenerationCoordinator } from './coordinator.js';
import { contextPlan } from '../core/context-plan.js';
import { importLorebook, exportLorebook } from '../core/lorebook-formats.js';
import { resolveRequestLore } from './lore-resolution.js';

const contentSecurityPolicy = (styleNonce?: string) => `default-src 'self'; script-src 'self'; style-src 'self'${styleNonce ? ` 'nonce-${styleNonce}'` : ''}; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
function loreImport<T>(parse: () => T): T {
  try { return parse(); }
  catch (error) {
    if (error instanceof ZodError || error instanceof AppError) throw error;
    throw new AppError(400, 'invalid_lorebook', error instanceof Error ? error.message : 'The lorebook could not be read.');
  }
}

export async function createApp(options: {
  database: string; staticDirectory?: string; migrationsDirectory?: string;
  provider?: Provider; https?: ServerOptions;
}) {
  const store = new Store(options.database, options.migrationsDirectory);
  const provider = options.provider ?? new OpenAICompatibleProvider();
  const coordinator = new GenerationCoordinator(store, provider);
  function publicSnapshot(id: string): ChatSnapshot {
    const { loreState: _state, loreResolution: _resolution, ...snapshot } = store.snapshot(id);
    return { ...snapshot, sources: { ...snapshot.sources, lorebook: undefined }, generations: snapshot.generations.map(generation => ({ ...generation,
      request: generation.request?.lore ? { ...generation.request, lore: { ...generation.request.lore, detailsAvailable: true, outcomes: [], diagnostics: [], scan: [], stateBefore: {}, stateDelta: {} } } : generation.request,
    })) };
  }
  const auth = new Auth(store);
  const secure = Boolean(options.https);
  const app = Fastify({ logger: false, bodyLimit: 1_000_000, ...(options.https ? { https: options.https } : {}) });
  await app.register(cookie);

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', contentSecurityPolicy());
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
      await fetchModels(input.connection.endpoint, apiKey);
      return { message: 'The endpoint accepted the connection check' };
    }
    const connection = input.connection;
    const preview = assembleRequest(connection, { title: 'Connection test', instructions: '', character: '', persona: '', targetInputTokens: connection.contextWindow - connection.maxOutputTokens }, [{ id: 'test', position: 1, complete: false, user: { id: 'test-user', revision: 0, text: 'Hi' }, assistant: { id: 'test-assistant', revision: 0, text: '' } }]);
    let response = '';
    try {
      const completion = await provider.stream(preview, apiKey, AbortSignal.timeout(30_000), text => { response += text; });
      if (!response.trim()) throw new AppError(502, 'empty_response', 'The model returned no text.');
      return { message: 'Test completed.', request: preview, response, usage: completion?.usage ?? null };
    } catch (error) {
      // Diagnostics have no saved turn to retry or delete.
      if (error instanceof AppError && ['empty_response', 'incomplete_stream'].includes(error.code)) {
        const reason = error.code === 'empty_response' ? 'The model returned no text for the test message.' : 'The test response stream ended before completion.';
        throw new AppError(502, error.code, `${reason} Nothing was saved. Click “Send test message” to try again.`);
      }
      throw error;
    }
  });
  app.get('/api/library', async request => {
    const { knownRevision } = z.object({ knownRevision: z.coerce.number().int().nonnegative().optional() }).strict().parse(request.query);
    return store.libraryUpdate(knownRevision);
  });
  app.post('/api/library', { bodyLimit: 16_100_000 }, async request => {
    const input = libraryCommandSchema.parse(request.body);
    const id = store.saveLibrary(input.revision, input.kind, input.data, undefined, input.kind === 'connections' ? input.apiKey : undefined, input.kind === 'characters' ? input.tagIds : undefined);
    coordinator.changed(); return { id };
  });
  app.put('/api/library/:id', { bodyLimit: 16_100_000 }, async request => {
    const { id } = z.object({ id: identity }).parse(request.params);
    const input = libraryCommandSchema.parse(request.body);
    store.saveLibrary(input.revision, input.kind, input.data, id, input.kind === 'connections' ? input.apiKey : undefined, input.kind === 'characters' ? input.tagIds : undefined);
    coordinator.changed(); return { id };
  });
  app.delete('/api/library/:id', async request => {
    const { id } = z.object({ id: identity }).parse(request.params);
    const input = z.object({ revision: revisionSchema, kind: z.enum(['personas', 'characters', 'prompts', 'connections', 'contexts', 'lorebooks']) }).strict().parse(request.body);
    store.deleteLibrary(input.revision, input.kind, id); coordinator.changed(); return { ok: true };
  });
  app.post('/api/library/default/restore', async request => {
    const { revision } = z.object({ revision: revisionSchema }).strict().parse(request.body);
    store.saveLibrary(revision, 'prompts', defaultPrompt, 'default'); coordinator.changed(); return { ok: true };
  });
  app.post('/api/library/import', { bodyLimit: 3_000_000 }, async request => {
    const input = z.object({ revision: revisionSchema, requestId: z.string().uuid().optional(), kind: z.enum(['personas', 'characters']), tagPolicy: tagPolicySchema.optional(), base64: z.string().max(2_700_000) }).strict().parse(request.body);
    const value = readCardFile(input.base64);
    if (input.kind === 'characters') {
      const result = store.importCard(input.revision, input.requestId ?? randomUUID(), value, input.tagPolicy);
      coordinator.changed(); return result;
    }
    let items;
    try { items = importPersonas(value); }
    catch (error) { if (error instanceof ZodError) throw error; throw new AppError(400, 'invalid_card', error instanceof Error ? error.message : 'Invalid card.'); }
    const ids = store.importLibrary(input.revision, input.kind, items); coordinator.changed(); return { ids };
  });
  app.post('/api/library/characters/preview', { bodyLimit: 3_000_000 }, async request => {
    const { base64 } = z.object({ base64: z.string().max(2_700_000) }).strict().parse(request.body);
    return store.previewCard(readCardFile(base64));
  });
  app.post('/api/library/tags', async request => {
    const input = z.object({ revision: revisionSchema, name: tagNameSchema }).strict().parse(request.body);
    const id = store.tags.create(input.revision, input.name); coordinator.changed();
    return { id, revision: store.libraryRevision() };
  });
  app.put('/api/library/tags/:id', async request => {
    const { id } = z.object({ id: identity }).parse(request.params);
    const input = z.object({ revision: revisionSchema, name: tagNameSchema }).strict().parse(request.body);
    store.tags.rename(input.revision, id, input.name); coordinator.changed(); return { revision: store.libraryRevision() };
  });
  app.delete('/api/library/tags/:id', async request => {
    const { id } = z.object({ id: identity }).parse(request.params);
    const { revision } = z.object({ revision: revisionSchema }).strict().parse(request.body);
    store.tags.delete(revision, id); coordinator.changed(); return { revision: store.libraryRevision() };
  });
  app.put('/api/library/characters/:id/tags', async request => {
    const { id } = z.object({ id: identity }).parse(request.params);
    const input = z.object({ revision: revisionSchema, tagIds: tagIdsSchema }).strict().parse(request.body);
    store.tags.setAssignments(input.revision, id, input.tagIds); coordinator.changed(); return { ok: true };
  });
  app.get('/api/library/characters/:id/tags/preview', async request => {
    const { id } = z.object({ id: identity }).parse(request.params);
    return { revision: store.libraryRevision(), tags: store.tags.embeddedReview(id) };
  });
  app.post('/api/library/characters/:id/tags/apply', async request => {
    const { id } = z.object({ id: identity }).parse(request.params);
    const input = z.object({ revision: revisionSchema, tagPolicy: tagPolicySchema }).strict().parse(request.body);
    const tags = store.tags.applyEmbedded(input.revision, id, input.tagPolicy); coordinator.changed();
    return { tags, revision: store.libraryRevision() };
  });
  app.post('/api/library/characters/:id/duplicate', async request => {
    const { id } = z.object({ id: identity }).parse(request.params);
    const { revision } = z.object({ revision: revisionSchema }).strict().parse(request.body);
    const copied = store.duplicateCharacter(revision, id); coordinator.changed(); return { id: copied };
  });
  app.post('/api/library/lorebooks/preview', { bodyLimit: 5_100_000 }, async request => {
    const { value } = z.object({ value: z.unknown() }).strict().parse(request.body);
    return loreImport(() => importLorebook(value, randomUUID));
  });
  app.post('/api/library/lorebooks/import', { bodyLimit: 5_100_000 }, async request => {
    const input = z.object({ revision: revisionSchema, requestId: z.string().uuid(), value: z.unknown() }).strict().parse(request.body);
    const result = store.importBook(input.revision, input.requestId, input.value); coordinator.changed(); return result;
  });
  app.post('/api/library/characters/:id/extract', async request => {
    const { id } = z.object({ id: identity }).parse(request.params);
    const input = z.object({ revision: revisionSchema, requestId: z.string().uuid() }).strict().parse(request.body);
    const result = store.extractBook(input.revision, input.requestId, id); coordinator.changed(); return result;
  });
  app.get('/api/library/:kind/:id/export', async request => {
    const { kind, id } = z.object({ kind: z.enum(['personas', 'characters', 'prompts', 'contexts', 'lorebooks']), id: identity }).parse(request.params);
    const item = store.libraries()[kind].find(item => item.id === id);
    if (!item) throw new AppError(404, 'item_not_found', 'Library item not found.');
    const { id: _id, revision: _revision, ...data } = item;
    if (kind === 'characters') {
      const card = data as Parameters<typeof exportCharacter>[0];
      const savedBook = store.libraries().lorebooks.find(book => book.id === card.lorebookId);
      const linkedBook = card.lorebookId === undefined ? undefined : savedBook ? (({ id: _bookId, revision: _bookRevision, ...book }) => book)(savedBook) : null;
      return exportCharacter(card, linkedBook);
    }
    if (kind === 'lorebooks') return exportLorebook(data as Parameters<typeof exportLorebook>[0]);
    if (kind === 'personas') return exportPersona(data as Parameters<typeof exportPersona>[0]);
    return data;
  });
  app.post('/api/chats', async request => {
    const input = selectionsSchema.parse(request.body);
    const id = store.createChat(input); coordinator.changed(); return { id };
  });
  app.put('/api/chats/:chatId/selections', async request => {
    const input = z.object({ revision: revisionSchema, settings: selectionsSchema }).strict().parse(request.body);
    store.updateChat(input.revision, chatId(request.params), input.settings); coordinator.changed(); return publicSnapshot(chatId(request.params));
  });
  app.delete('/api/chats/:chatId', async request => {
    const { revision } = z.object({ revision: revisionSchema }).strict().parse(request.body);
    store.deleteChat(revision, chatId(request.params)); coordinator.changed(); return { ok: true };
  });
  app.put('/api/chats/:chatId/history', { bodyLimit: 25_000_000 }, async request => {
    const input = replaceHistorySchema.parse(request.body);
    store.replaceHistory(input.revision, chatId(request.params), input.turns); coordinator.changed(); return { ok: true };
  });
  app.get('/api/chats/:chatId/context/plan', async request => {
    const snapshot = store.snapshot(chatId(request.params));
    const loreResolution = await resolveRequestLore(snapshot, coordinator.loreRegex);
    store.checkRevision(snapshot.revision, snapshot.id);
    return contextPlan({ ...snapshot, loreResolution });
  });
  app.get('/api/chats/:chatId/generations/:id/request', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const generation = store.generation(id);
    if (!generation || generation.chatId !== chatId(request.params)) throw new AppError(404, 'generation_not_found', 'Saved response request not found.');
    return generation.request;
  });
  app.post('/api/chats/:chatId/context/prepare', async (request, reply) => {
    const input = z.object({ revision: revisionSchema, requestId: z.string().uuid(), mode: z.enum(['prepare', 'step', 'repair']) }).strict().parse(request.body);
    return reply.code(202).send(await coordinator.context.startResolved(chatId(request.params), input.revision, input.requestId, input.mode));
  });
  app.post('/api/chats/:chatId/context/clear', async request => {
    const { revision } = z.object({ revision: revisionSchema }).strict().parse(request.body);
    store.contexts.clearMemory(chatId(request.params), revision); coordinator.changed(); return { ok: true };
  });
  app.post('/api/chats/:chatId/context/refresh', async request => {
    const input = z.object({ revision: revisionSchema, requestId: z.string().uuid() }).strict().parse(request.body);
    const existing = store.contexts.commandJob(chatId(request.params), input.requestId, 'refresh');
    if (existing?.refresh) return { jobId: existing.id, report: existing.refresh };
    const snapshot = store.snapshot(chatId(request.params));
    const lore = await resolveRequestLore(snapshot, coordinator.loreRegex);
    const result = store.contexts.refresh(snapshot.id, input.revision, input.requestId, lore);
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
    return store.contexts.details(id);
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
  app.post('/api/context/jobs/:id/repair', { bodyLimit: 1_100_000 }, async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = z.object({ revision: revisionSchema, requestId: z.string().uuid(), action: z.enum(['approve', 'regenerate', 'close']), text: z.string().max(1_000_000).optional() }).strict().parse(request.body);
    return coordinator.context.repairActionResolved(id, input.revision, input.requestId, input.action, input.text);
  });
  for (const prefix of ['/api', '/api/chats/:chatId']) {
    app.get(prefix + (prefix === '/api' ? '/chat' : ''), async request => publicSnapshot(chatId(request.params)));
    app.put(prefix + '/settings', async request => {
      const input = saveSettingsSchema.parse(request.body);
      store.saveSettings(input.revision, input.connection, input.settings, input.apiKey, chatId(request.params));
      coordinator.changed(); return publicSnapshot(chatId(request.params));
    });
    app.post(prefix + '/preview', async (request, reply) => {
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
      const controller = new AbortController();
      const disconnect = () => controller.abort();
      request.raw.once('aborted', disconnect); reply.raw.once('close', disconnect);
      try {
        const lore = await resolveRequestLore({ ...snapshot, turns }, coordinator.loreRegex, controller.signal);
        store.checkRevision(input.revision, snapshot.id);
        return assembleRequest(snapshot.connection, snapshot.settings, turns, snapshot.sources, snapshot.context, { ...(input.inspection ? { validateLimits: false, allowStale: true } : {}), lore });
      } finally { request.raw.removeListener('aborted', disconnect); reply.raw.removeListener('close', disconnect); }
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
      store.editPart(input.revision, id, part, input.text, chatId(request.params)); coordinator.changed(); return publicSnapshot(chatId(request.params));
    });
    app.delete(prefix + '/turns/:id', async request => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { revision } = z.object({ revision: revisionSchema }).strict().parse(request.body);
      store.deleteTurn(revision, id, chatId(request.params)); coordinator.changed(); return publicSnapshot(chatId(request.params));
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
    const index = readFileSync(join(options.staticDirectory, 'index.html'), 'utf8');
    const sendIndex = (reply: FastifyReply) => {
      const nonce = randomBytes(24).toString('base64');
      reply.header('Content-Security-Policy', contentSecurityPolicy(nonce));
      reply.header('Cache-Control', 'no-store');
      return reply.type('text/html').send(index.replace('<head>', `<head><meta name="csp-nonce" content="${nonce}">`));
    };
    await app.register(staticFiles, { root: options.staticDirectory });
    app.get('/', async (_request, reply) => sendIndex(reply));
    app.get('/index.html', async (_request, reply) => sendIndex(reply));
    app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ message: 'Not found.' }) : sendIndex(reply));
  }
  app.addHook('preClose', async () => coordinator.shutdown());
  app.addHook('onClose', async () => store.close());
  return { app, store, coordinator };
}
