import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/server/app.js';
import type { ChatSnapshot, RequestPreview } from '../src/shared/contracts.js';
import { defaultPrompt } from '../src/shared/library.js';
import { startMockProvider } from './support/mock-provider.js';

let directory: string;
let mock: Awaited<ReturnType<typeof startMockProvider>>;
let instance: Awaited<ReturnType<typeof createApp>>;
let cookie: string;
const password = 'synthetic-owner-password';
const connection = { name: 'Synthetic model', model: 'mock-roleplay', contextWindow: 32_000, maxOutputTokens: 1000, customParameters: { temperature: 0.8 } };

async function command(url: string, payload: unknown, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'POST') {
  return instance.app.inject({ method, url, headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, payload: JSON.stringify(payload) });
}
async function state() {
  const response = await instance.app.inject({ method: 'GET', url: '/api/chat', headers: { host: 'localhost', cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<ChatSnapshot>();
}
async function waitForIdle() {
  await expect.poll(async () => (await state()).generations.some((generation) => generation.status === 'running'), { timeout: 5000 }).toBe(false);
  return state();
}

it('allows editor styles with a fresh per-document nonce while keeping scripts restricted', async () => {
  const staticDirectory = join(directory, 'client'); mkdirSync(staticDirectory);
  writeFileSync(join(staticDirectory, 'index.html'), '<!doctype html><html><head><title>ORE</title></head><body></body></html>');
  writeFileSync(join(staticDirectory, 'app.css'), 'body { color: white; }');
  const staticApp = await createApp({ database: join(directory, 'static.sqlite'), staticDirectory });
  try {
    const first = await staticApp.app.inject({ method: 'GET', url: '/' });
    expect(first.statusCode).toBe(200);
    const nonce = first.body.match(/name="csp-nonce" content="([^"]+)"/)![1];
    expect(first.headers['content-security-policy']).toContain(`style-src 'self' 'nonce-${nonce}'`);
    expect(first.headers['content-security-policy']).toContain("script-src 'self';");
    expect(first.headers['content-security-policy']).not.toContain('unsafe-inline');
    expect(first.headers['cache-control']).toBe('no-store');
    const next = await staticApp.app.inject({ method: 'GET', url: '/index.html' });
    expect(next.body).not.toContain(nonce);
    const fallback = await staticApp.app.inject({ method: 'GET', url: '/memory' });
    expect(fallback.body).toContain('name="csp-nonce"');
    const css = await staticApp.app.inject({ method: 'GET', url: '/app.css' });
    expect(css.body).toContain('color: white');
    expect(css.headers['content-security-policy']).toContain("style-src 'self';");
  } finally { await staticApp.app.close(); }
});
async function submit(text = 'I open the tower door.', requestId = randomUUID()) {
  return command('/api/turns', { revision: (await state()).revision, requestId, text });
}

beforeEach(async () => {
  cookie = '';
  directory = mkdtempSync(join(tmpdir(), 'roleplay-test-'));
  mock = await startMockProvider();
  instance = await createApp({ database: join(directory, 'chat.sqlite') });
  const setup = await command('/api/setup', { password });
  expect(setup.statusCode).toBe(200);
  cookie = setup.headers['set-cookie']!.toString().split(';')[0];
  const snapshot = await state();
  const save = await command('/api/settings', { revision: snapshot.revision, connection: { ...connection, endpoint: mock.url }, settings: snapshot.settings, apiKey: 'synthetic-api-secret' }, 'PUT');
  expect(save.statusCode).toBe(200);
});
afterEach(async () => {
  await instance.app.close();
  await mock.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('persistent chat and generation', () => {
  it('previews and sends the same bounded recent history without creating summary jobs', async () => {
    instance.store.saveLibrary(instance.store.libraries().revision, 'prompts', { ...defaultPrompt, blocks: defaultPrompt.blocks.filter(block => block.id !== 'summary') }, 'default');
    instance.store.replaceHistory((await state()).revision, 'main', Array.from({ length: 12 }, (_, i) => ({ user: `Input ${i}. ` + 'A brass key. '.repeat(20), assistant: `Response ${i}. ` + 'The cellar is locked. '.repeat(20), complete: true })));
    const preset = instance.store.libraries().contexts[0];
    instance.store.updateChat((await state()).revision, 'main', { title: 'Recent mode', targetInputTokens: 300, connectionId: 'main', promptId: 'default', characterId: null, personaId: null, contextPresetId: preset.id });
    const current = await state(), text = 'I return the key.';
    const response = await command('/api/preview', { revision: current.revision, text, inspection: true });
    expect(response.statusCode).toBe(200);
    const preview = response.json<RequestPreview>();
    expect(preview.budget.inputTokens).toBeLessThanOrEqual(300);
    expect(preview.history?.verbatimTurnIds.length).toBeLessThan(current.turns.length);
    const prepare = await command('/api/chats/main/context/prepare', { revision: current.revision, requestId: randomUUID(), mode: 'prepare' });
    expect(prepare.statusCode).toBe(422); expect(prepare.json().code).toBe('summaries_disabled');
    expect((await state()).revision).toBe(current.revision);
    expect((await submit(text)).statusCode).toBe(202);
    const saved = await waitForIdle();
    expect(saved.generations[0].status).toBe('succeeded');
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].body).toEqual(preview.body);
    expect(saved.generations[0].request?.body).toEqual(preview.body);
    expect(saved.context.jobs).toEqual([]);
  });

  it('saves an empty preset with advisory warnings and fails sending before a provider request', async () => {
    const result = await command('/api/library/default', { revision: instance.store.libraries().revision, kind: 'prompts', data: { name: 'Empty', blocks: [] } }, 'PUT');
    expect(result.statusCode).toBe(200);
    const preview = await command('/api/preview', { revision: (await state()).revision, inspection: true, text: 'Unsent input' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().body.messages).toEqual([]);
    expect(preview.json().warnings).toHaveLength(4);
    await submit(); const saved = await waitForIdle();
    expect(saved.generations[0].status).toBe('failed');
    expect(saved.generations[0].error).toContain('prompt is empty');
    expect(mock.requests).toEqual([]);
  });

  it('prepares locally without a summary Connection, validates commands and retries without another job', async () => {
    const snapshot = await state(), preset = instance.store.libraries().contexts[0];
    instance.store.updateChat(snapshot.revision, 'main', { title: snapshot.settings.title, targetInputTokens: 10_000, connectionId: 'main', promptId: 'default', characterId: null, personaId: null, contextPresetId: preset.id });
    const current = await state(), requestId = randomUUID();
    const result = await command('/api/chats/main/context/prepare', { revision: current.revision, requestId, mode: 'prepare' });
    expect(result.statusCode).toBe(202);
    const job = instance.store.contexts.job(result.json().jobId);
    expect(job).toMatchObject({ status: 'succeeded', mode: 'prepare', generatedCount: 0, refresh: { changed: false }, outcome: { verbatimTurns: 0 } });
    const after = await state();
    expect((await command('/api/chats/main/context/prepare', { revision: current.revision, requestId, mode: 'prepare' })).json()).toEqual(result.json());
    expect(await state()).toEqual(after);
    expect((await command('/api/chats/main/context/prepare', { revision: current.revision, requestId: randomUUID(), mode: 'prepare' })).statusCode).toBe(409);
    expect((await command('/api/chats/main/context/prepare', { revision: after.revision, requestId: 'invalid', mode: 'prepare' })).statusCode).toBe(400);
    const unauthorized = await instance.app.inject({ method: 'POST', url: '/api/chats/main/context/prepare', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { revision: 0, requestId: randomUUID(), mode: 'prepare' } });
    expect(unauthorized.statusCode).toBe(401); expect(mock.requests).toHaveLength(0);
  });

  it('validates and authenticates the local refresh endpoint without issuing a provider request', async () => {
    const snapshot = await state();
    const preset = instance.store.libraries().contexts[0];
    instance.store.updateChat(snapshot.revision, 'main', { title: snapshot.settings.title, targetInputTokens: 10_000, connectionId: 'main', promptId: 'default', characterId: null, personaId: null, contextPresetId: preset.id });
    const current = await state(), requestId = randomUUID();
    const result = await command('/api/chats/main/context/refresh', { revision: current.revision, requestId });
    expect(result.statusCode).toBe(200);
    expect(result.json().report).toMatchObject({ changed: false, verbatimBefore: 0, verbatimAfter: 0 });
    expect((await command('/api/chats/main/context/refresh', { revision: current.revision, requestId })).json()).toEqual(result.json());
    expect((await command('/api/chats/main/context/refresh', { revision: current.revision, requestId: randomUUID() })).statusCode).toBe(409);
    expect((await command('/api/chats/main/context/refresh', { revision: (await state()).revision, requestId: 'invalid' })).statusCode).toBe(400);
    const unauthorized = await instance.app.inject({ method: 'POST', url: '/api/chats/main/context/refresh', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { revision: 0, requestId: randomUUID() } });
    expect(unauthorized.statusCode).toBe(401); expect(mock.requests).toHaveLength(0);
  });

  it('checks and tests unsaved Connection settings without changing chat history or calibrating the counter', async () => {
    const before = await state();
    const input = { connection: { ...before.connection, maxOutputTokens: 4096, customParameters: { reasoning_effort: 'high' } }, connectionId: before.settings.connectionId };
    expect(mock.requests).toHaveLength(0);
    const check = await command('/api/connections/diagnose', { ...input, action: 'check' });
    expect(check.statusCode).toBe(200);
    expect(check.json().message).toBe('The endpoint accepted the connection check');
    expect(mock.modelRequests.at(-1)?.authorization).toBe('Bearer synthetic-api-secret');
    const test = await command('/api/connections/diagnose', { ...input, action: 'test' });
    expect(test.statusCode).toBe(200);
    const result = test.json();
    expect(result.request.body).toEqual(mock.requests[0].body);
    expect(result.request.body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
    expect(result.request.body.max_tokens).toBe(4096);
    expect(result.request.body.reasoning_effort).toBe('high');
    expect(result.request.budget.reservedOutputTokens).toBe(4096);
    expect(result.usage).toEqual({ inputTokens: 321, outputTokens: 17, totalTokens: 338 });
    expect(result.request.budget.inputTokens).not.toBe(result.usage.inputTokens);
    expect(JSON.stringify(result)).not.toContain('synthetic-api-secret');
    expect(await state()).toEqual(before);
    mock.setMode('no-usage');
    const noUsage = await command('/api/connections/diagnose', { ...input, action: 'test', connection: { ...before.connection, model: 'gpt-4o', maxOutputTokens: 12 }, apiKey: 'entered-test-key' });
    expect(noUsage.json().usage).toBeNull();
    expect(noUsage.json().request.budget.counting.tokenizer).toBe('cl100k_base');
    expect(mock.requests[1].body.max_tokens).toBe(12);
    expect(mock.requests[1].authorization).toBe('Bearer entered-test-key');
    expect(await state()).toEqual(before);
    const changedEndpoint = await command('/api/connections/diagnose', { ...input, action: 'test', connection: { ...before.connection, endpoint: 'http://localhost:9/v1' } });
    expect(changedEndpoint.statusCode).toBe(422);
    expect(changedEndpoint.json().code).toBe('saved_key_endpoint_changed');
    mock.setModelMode('error');
    const failedCheck = await command('/api/connections/diagnose', { ...input, action: 'check' });
    expect(failedCheck.statusCode).toBe(502);
    expect(failedCheck.body).not.toContain('upstream-secret');
    const keylessId = instance.store.saveLibrary(instance.store.libraries().revision, 'connections', { ...before.connection!, endpoint: 'http://localhost:9/v1' });
    mock.setModelMode('normal');
    expect((await command('/api/connections/diagnose', { connection: before.connection, connectionId: keylessId, action: 'check' })).statusCode).toBe(200);
    expect(mock.modelRequests.at(-1)?.authorization).toBeUndefined();
  });

  it.each(['empty', 'whitespace', 'broken'] as const)('reports a %s test response without leaving saved work and allows an explicit retry', async mode => {
    const before = await state();
    const libraryBefore = instance.store.libraries();
    const input = { action: 'test', connection: before.connection, connectionId: before.settings.connectionId };
    mock.setMode(mode);
    const failed = await command('/api/connections/diagnose', input);
    expect(failed.statusCode).toBe(502);
    expect(failed.json().code).toBe(mode === 'broken' ? 'incomplete_stream' : 'empty_response');
    expect(failed.json().message).toContain('Send test message');
    expect(failed.json().message).toContain('Nothing was saved');
    expect(failed.json().message).not.toMatch(/\bturn\b|pending|delete/i);
    expect(await state()).toEqual(before);
    expect(instance.store.libraries()).toEqual(libraryBefore);

    mock.setMode('normal');
    const retry = await command('/api/connections/diagnose', input);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().response).toBe('The lantern flickers. 🕯');
    expect(mock.requests).toHaveLength(2);
    expect(await state()).toEqual(before);
    expect(instance.store.libraries()).toEqual(libraryBefore);
  });

  it('uses server counting for over-budget inspection and keeps saved estimates unchanged after a model switch', async () => {
    await submit();
    const before = await waitForIdle();
    const savedRequest = before.generations[0].request;
    const save = await command('/api/settings', { revision: before.revision, connection: { ...before.connection, model: 'gpt-4o' }, settings: { ...before.settings, targetInputTokens: 1 } }, 'PUT');
    expect(save.statusCode).toBe(200);
    const after = await state();
    const preview = await command('/api/preview', { revision: after.revision, inspection: true, text: 'Another turn.' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().budget.counting.tokenizer).toBe('cl100k_base');
    expect(preview.json().budget.inputTokens).toBeGreaterThan(1);
    expect((await command('/api/preview', { revision: after.revision })).statusCode).toBe(422);
    expect((await state()).generations[0].request).toEqual(savedRequest);
    expect((await state()).generations[0].usage).toEqual(before.generations[0].usage);
  });

  it('persists provider usage from the final empty-choice chunk across reload and later edits', async () => {
    await submit();
    const saved = await waitForIdle();
    expect(saved.generations[0].usage).toEqual({ inputTokens: 321, outputTokens: 17, totalTokens: 338 });
    expect(mock.requests[0].body.stream_options).toEqual({ include_usage: true });
    await command(`/api/turns/${saved.turns[0].id}/user`, { revision: saved.revision, text: 'A later edit.' }, 'PATCH');
    expect((await state()).generations[0].usage).toEqual(saved.generations[0].usage);
    await instance.app.close();
    instance = await createApp({ database: join(directory, 'chat.sqlite') });
    expect((await state()).generations[0].usage).toEqual(saved.generations[0].usage);
  });

  it.each(['no-usage', 'bad-usage'] as const)('accepts a valid response with %s without inventing token counts', async mode => {
    mock.setMode(mode); await submit();
    const saved = await waitForIdle();
    expect(saved.generations[0].status).toBe('succeeded');
    expect(saved.generations[0].usage).toBeNull();
  });

  it('rejects a second server before it can invalidate the first server operation', async () => {
    mock.setMode('hold'); await submit();
    await expect.poll(() => mock.requests.length).toBe(1);
    await expect(createApp({ database: join(directory, 'chat.sqlite') })).rejects.toThrow('already using this database');
    expect((await state()).generations[0].status).toBe('running');
    mock.finishAll(); expect((await waitForIdle()).turns[0].complete).toBe(true);
  });
  it('persists the response and exact request while excluding credentials from public state', async () => {
    const before = await state();
    const preview = await command('/api/preview', { revision: before.revision, text: 'I open the tower door.' });
    expect((await submit()).statusCode).toBe(202);
    const snapshot = await waitForIdle();
    expect(snapshot.turns[0].complete).toBe(true);
    expect(snapshot.turns[0].assistant.text).toBe('The lantern flickers. 🕯');
    expect(snapshot.generations[0].request!.body).toEqual(mock.requests[0].body);
    expect(preview.json().body).toEqual(mock.requests[0].body);
    expect(mock.requests[0].authorization).toBe('Bearer synthetic-api-secret');
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-api-secret');
    const ids = snapshot.turns[0];
    await instance.app.close();
    instance = await createApp({ database: join(directory, 'chat.sqlite') });
    const reloaded = await state();
    expect(reloaded.turns[0]).toEqual(ids);
    expect(reloaded.generations[0].request).toEqual(snapshot.generations[0].request);
    expect(mock.requests).toHaveLength(1);
  });

  it('allows only one simultaneous submission and makes a repeated request id safe', async () => {
    mock.setMode('hold');
    const snapshot = await state();
    const requestId = randomUUID();
    const payload = { revision: snapshot.revision, requestId, text: 'First input' };
    const [first, second] = await Promise.all([command('/api/turns', payload), command('/api/turns', { ...payload, requestId: randomUUID(), text: 'Competing input' })]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);
    expect((await state()).turns).toHaveLength(1);
    const duplicate = await command('/api/turns', payload);
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toEqual(first.json());
    expect((await command('/api/turns', { ...payload, text: 'Different input' })).statusCode).toBe(409);
    await expect.poll(() => mock.requests.length).toBe(1);
    expect((await submit('Another input')).statusCode).toBe(409);
    mock.finishAll(); await waitForIdle();
  });

  it('keeps blank edits complete with stable identities and separate part revisions', async () => {
    await submit(); let snapshot = await waitForIdle();
    const original = snapshot.turns[0];
    for (const part of ['user', 'assistant'] as const) {
      const result = await command(`/api/turns/${original.id}/${part}`, { revision: snapshot.revision, text: '' }, 'PATCH');
      expect(result.statusCode).toBe(200); snapshot = result.json();
    }
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({ id: original.id, complete: true, user: { id: original.user.id, revision: 1, text: '' }, assistant: { id: original.assistant.id, revision: 2, text: '' } });
    await submit('Continue'); snapshot = await waitForIdle();
    expect(snapshot.turns).toHaveLength(2);
    const request = snapshot.generations[0].request!;
    expect(request.body.messages.filter((message) => message.role !== 'system')).toEqual([{ role: 'user', content: 'Continue' }]);
    expect(request.coverage).toHaveLength(2);
  });

  it('trims boundary newlines from submissions, previews, completed responses and both edited parts', async () => {
    mock.setMode('padded');
    const text = '\r\n \n  I enter.\n\nI look around.\r\n\r\n ';
    const preview = await command('/api/preview', { revision: (await state()).revision, text });
    await submit(text); let snapshot = await waitForIdle();
    expect(snapshot.turns[0].user.text).toBe('  I enter.\n\nI look around.');
    expect(snapshot.turns[0].assistant.text).toBe('The lantern\n\nflickers. 🕯');
    expect(snapshot.generations[0].partialText).toBe(snapshot.turns[0].assistant.text);
    expect(preview.json().body).toEqual(mock.requests[0].body);
    for (const part of ['user', 'assistant']) {
      const result = await command(`/api/turns/${snapshot.turns[0].id}/${part}`, { revision: snapshot.revision, text: '\n\n  Edited\n\nparagraph\n \n' }, 'PATCH');
      expect(result.statusCode).toBe(200); snapshot = result.json();
    }
    expect(snapshot.turns[0].user.text).toBe('  Edited\n\nparagraph');
    expect(snapshot.turns[0].assistant.text).toBe('  Edited\n\nparagraph');
    expect((await submit('\n \n')).statusCode).toBe(400);
    expect((await state()).turns).toHaveLength(1);
  });

  it('discovers models with saved or entered keys without exposing keys or upstream errors', async () => {
    const saved = await command('/api/models', { endpoint: mock.url, connectionId: 'main' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ models: ['another-model', 'synthetic-roleplay'] });
    expect(mock.modelRequests.at(-1)?.authorization).toBe('Bearer synthetic-api-secret');
    await command('/api/models', { endpoint: mock.url, connectionId: 'main', apiKey: 'new-key' });
    expect(mock.modelRequests.at(-1)?.authorization).toBe('Bearer new-key');
    await command('/api/models', { endpoint: mock.url, connectionId: 'main', apiKey: '' });
    expect(mock.modelRequests.at(-1)?.authorization).toBeUndefined();
    for (const mode of ['invalid', 'redirect'] as const) {
      mock.setModelMode(mode);
      const response = await command('/api/models', { endpoint: mock.url, connectionId: 'main' });
      expect(response.statusCode).toBe(502);
      expect(response.body).not.toContain('upstream-secret');
      expect(response.body).not.toContain('synthetic-api-secret');
      expect(response.json().message).toContain('model identifier manually');
    }
    expect((await command('/api/models', { endpoint: mock.url + '?key=secret' })).statusCode).toBe(400);
    expect((await instance.app.inject({ method: 'POST', url: '/api/models', headers: { host: 'localhost', origin: 'http://localhost' }, payload: { endpoint: mock.url } })).statusCode).toBe(401);
  });

  it.each(['models', 'check', 'test'] as const)('explains missing and rejected API keys for %s without saving editor settings', async action => {
    const before = await state();
    mock.setModelMode('error');
    mock.setMode('error');
    const input = action === 'models' ? { endpoint: mock.url } : { action, connection: before.connection };
    for (const apiKey of ['', 'entered-test-secret']) {
      const response = await command(action === 'models' ? '/api/models' : '/api/connections/diagnose', { ...input, apiKey });
      expect(response.statusCode).toBe(502);
      expect(response.json().message).toContain(apiKey ? 'rejected the API key' : 'Enter your provider’s API key');
      expect(response.json().message).toContain('401');
      expect(response.body).not.toContain('entered-test-secret');
      expect(response.body).not.toContain('upstream-secret');
      expect(await state()).toEqual(before);
    }
  });

  it.each([
    [403, 'permission'],
    [404, 'API base URL'],
    [429, 'limits and balance'],
    [503, 'Try again later'],
  ] as const)('provides recovery guidance for model-list HTTP %s without exposing the provider response', async (status, guidance) => {
    mock.setModelMode(status);
    const response = await command('/api/models', { endpoint: mock.url, connectionId: 'main' });
    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe('model_list_unavailable');
    expect(response.json().message).toContain(`HTTP ${status}`);
    expect(response.json().message).toContain(guidance);
    expect(response.body).not.toContain('upstream-secret');
    expect(response.body).not.toContain('synthetic-api-secret');
  });

  it('continues generation after an observer disconnects and reconciles both clients', async () => {
    mock.setMode('hold');
    const address = await instance.app.listen({ host: '127.0.0.1', port: 0 });
    const observer = new AbortController();
    const response = await fetch(`${address}/api/events`, { headers: { cookie }, signal: observer.signal });
    const reader = response.body!.getReader();
    await reader.read();
    await submit();
    await expect.poll(() => mock.requests.length).toBe(1);
    observer.abort();
    await reader.cancel().catch(() => {});
    expect((await state()).generations[0].status).toBe('running');
    mock.finishAll(); const saved = await waitForIdle();
    const reconnected = await fetch(`${address}/api/chat`, { headers: { cookie } }).then((result) => result.json());
    expect(reconnected.turns).toEqual(saved.turns);
    expect(saved.turns[0].complete).toBe(true);
  });

  it('cancels safely, ignores late results, blocks new turns, and retries the existing pending turn', async () => {
    mock.setMode('hold'); await submit();
    await expect.poll(async () => (await state()).generations[0].partialText).toBe('The lantern ');
    let snapshot = await state(); const turnId = snapshot.turns[0].id;
    const cancel = await command(`/api/generations/${snapshot.generations[0].id}/cancel`, {});
    expect(cancel.statusCode).toBe(200);
    mock.finishAll(); snapshot = await state();
    expect(snapshot.generations[0].status).toBe('cancelled');
    expect(snapshot.turns[0]).toMatchObject({ complete: false, assistant: { text: '' } });
    expect((await submit()).statusCode).toBe(409);
    expect((await command(`/api/turns/${turnId}/assistant`, { revision: snapshot.revision, text: '' }, 'PATCH')).statusCode).toBe(409);
    mock.setMode('normal');
    expect((await command('/api/retry', { revision: snapshot.revision, requestId: randomUUID() })).statusCode).toBe(202);
    snapshot = await waitForIdle();
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]).toMatchObject({ id: turnId, complete: true });
    expect(mock.requests).toHaveLength(2);
  });

  it('recovers interrupted operations without issuing another model request on restart', async () => {
    mock.setMode('hold'); await submit();
    await expect.poll(async () => (await state()).generations[0].partialText).toBe('The lantern ');
    const turnId = (await state()).turns[0].id;
    await instance.app.close();
    instance = await createApp({ database: join(directory, 'chat.sqlite') });
    let snapshot = await state();
    expect(snapshot.generations[0]).toMatchObject({ status: 'interrupted', partialText: 'The lantern ' });
    expect(snapshot.turns[0]).toMatchObject({ id: turnId, complete: false });
    expect(mock.requests).toHaveLength(1);
    mock.setMode('normal');
    await command('/api/retry', { revision: snapshot.revision, requestId: randomUUID() });
    snapshot = await waitForIdle(); expect(snapshot.turns[0].complete).toBe(true);
  });

  it.each(['broken', 'empty', 'error', 'whitespace'] as const)('leaves %s responses pending and saves only safe errors', async (mode) => {
    mock.setMode(mode); await submit(); const snapshot = await waitForIdle();
    expect(snapshot.turns[0].complete).toBe(false);
    expect(snapshot.generations[0].status).toBe('failed');
    expect(JSON.stringify(snapshot)).not.toContain('upstream-secret-do-not-save');
    expect((await submit()).statusCode).toBe(409);
  });

  it('fails over-budget preparation before calling the provider and preserves the pending input', async () => {
    let snapshot = await state();
    await command('/api/settings', { revision: snapshot.revision, connection: snapshot.connection, settings: { ...snapshot.settings, targetInputTokens: 1 } }, 'PUT');
    await submit(); snapshot = await waitForIdle();
    expect(snapshot.generations[0].status).toBe('failed');
    expect(snapshot.generations[0].request).toBeNull();
    expect(snapshot.turns[0].user.text).toBe('I open the tower door.');
    expect(mock.requests).toHaveLength(0);
  });

  it('rejects edits during generation and stale writes from another device', async () => {
    mock.setMode('hold'); const before = await state(); await submit();
    const current = await state(); const id = current.turns[0].id;
    expect((await command(`/api/turns/${id}/user`, { revision: current.revision, text: 'Edited' }, 'PATCH')).statusCode).toBe(409);
    expect((await command(`/api/turns/${id}`, { revision: current.revision }, 'DELETE')).statusCode).toBe(409);
    await expect.poll(() => mock.requests.length).toBe(1); mock.finishAll(); await waitForIdle();
    expect((await command('/api/settings', { revision: before.revision, connection: before.connection, settings: before.settings }, 'PUT')).statusCode).toBe(409);
  });
});

describe('owner access', () => {
  it('requires login, rejects cross-origin commands and DNS rebinding, and never returns saved API keys', async () => {
    expect((await instance.app.inject({ method: 'GET', url: '/api/chat', headers: { host: 'localhost' } })).statusCode).toBe(401);
    expect((await instance.app.inject({ method: 'POST', url: '/api/logout', headers: { host: 'localhost', origin: 'https://other.example', cookie }, payload: {} })).statusCode).toBe(403);
    expect((await instance.app.inject({ method: 'GET', url: '/api/session', headers: { host: 'attacker.example' } })).statusCode).toBe(403);
    expect(JSON.stringify(await state())).not.toContain('synthetic-api-secret');
    const login = await command('/api/login', { password });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toContain('HttpOnly');
    expect(login.headers['set-cookie']).toContain('SameSite=Strict');
    await command('/api/logout', {});
    expect((await instance.app.inject({ method: 'GET', url: '/api/chat', headers: { host: 'localhost', cookie } })).statusCode).toBe(401);
  });
});

it('authenticates regeneration and variant selection, deduplicates commands, and keeps exact per-variant requests', async () => {
  await submit(); await waitForIdle();
  const before = await state(), turn = before.turns[0], originalId = turn.assistant.variantId;
  const requestId = randomUUID();
  const regenerate = () => command(`/api/turns/${turn.id}/regenerate`, { revision: before.revision, requestId });
  expect((await regenerate()).statusCode).toBe(202);
  const duplicate = await regenerate(); expect(duplicate.statusCode).toBe(202);
  const after = await waitForIdle();
  expect(after.turns[0].variants).toHaveLength(2);
  expect(mock.requests).toHaveLength(2);
  expect(after.generations[0].kind).toBe('regeneration');
  expect(after.generations[0].request?.body.messages.filter(message => message.role === 'assistant')).toEqual([]);
  const chosen = await command(`/api/turns/${turn.id}/variants/${originalId}/select`, { revision: after.revision });
  expect(chosen.statusCode).toBe(200);
  expect((await state()).turns[0].assistant.variantId).toBe(originalId);
  expect((await command(`/api/turns/${turn.id}/variants/${originalId}/select`, { revision: 0 })).statusCode).toBe(409);
  expect((await command(`/api/turns/${turn.id}/variants/unknown/select`, { revision: (await state()).revision })).statusCode).toBe(404);
  expect((await command(`/api/turns/not-a-turn/regenerate`, { revision: (await state()).revision, requestId: randomUUID() })).statusCode).toBe(400);
  await submit('Later input'); await waitForIdle();
  expect((await command(`/api/turns/${turn.id}/regenerate`, { revision: (await state()).revision, requestId: randomUUID() })).statusCode).toBe(409);
  const unauthenticated = await instance.app.inject({ method: 'POST', url: `/api/turns/${turn.id}/variants/${originalId}/select`, headers: { host: 'localhost', origin: 'http://localhost' }, payload: { revision: (await state()).revision } });
  expect(unauthenticated.statusCode).toBe(401);
  expect(JSON.stringify(await state())).not.toContain('synthetic-api-secret');
});
