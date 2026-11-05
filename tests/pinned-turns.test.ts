import { seedTranscript } from './support/transcript-fixture.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { contextPlan } from '../src/core/context-plan.js';
import { sourceOf } from '../src/core/context.js';
import { estimateInputTokens } from '../src/core/prompt.js';
import { Store } from '../src/persistence/store.js';
import { createApp } from '../src/server/app.js';
import { BackupService } from '../src/server/backups.js';
import { defaultContextPreset, type ContextPlan, type SummaryNode } from '../src/shared/context.js';
import type { RequestEstimate, RequestPreview } from '../src/shared/contracts.js';
import { defaultPrompt } from '../src/shared/library.js';
import type { PinList, StorySnapshot } from '../src/shared/transcript.js';
import { startMockProvider } from './support/mock-provider.js';
import { removePinSchema } from './support/schema-16.js';

const close: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of close.splice(0).reverse()) await stop(); });
function filename(name: string) {
  const directory = mkdtempSync(join(tmpdir(), 'ore-pinned-turns-'));
  close.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, name + '.sqlite');
}
const promptBlocks = defaultPrompt.blocks.filter(block => ['summary', 'pinned-messages', 'messages'].includes(block.id));
const excerptIntro = 'The user has explicitly indicated that the following messages are important to the story. Pay particular attention to the facts, decisions, promises, and relationships they establish when continuing the current conversation. Read them as excerpts from earlier turns.';
const fixtures = [
  { user: '', assistant: 'The opening bell rings.', complete: true },
  { user: 'I promised the keeper a {{char}} key.', assistant: 'The keeper agreed.\n\n![bell](https://example.test/bell.png)', complete: true },
  { user: 'The ferry left.', assistant: 'The previous answer contains a secret.', complete: true },
];

async function fixture() {
  const mock = await startMockProvider();
  close.push(() => mock.close());
  const path = filename('source');
  const { app, store, coordinator } = await createApp({ database: path });
  close.push(() => app.close());
  const host = { host: 'localhost', origin: 'http://localhost' };
  const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: host, payload: { password: 'test-pinned-turns-password' } });
  expect(setup.statusCode).toBe(200);
  const headers = { ...host, cookie: String(setup.headers['set-cookie']).split(';')[0] };
  const command = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, payload?: object, epoch?: string) =>
    app.inject({ method, url: '/api/chats/' + path, headers: { ...headers, ...(epoch ? { 'x-ore-epoch': epoch } : {}) }, payload });
  const connectionId = store.saveLibrary(store.libraryRevision(), 'connections', {
    name: 'Synthetic', endpoint: mock.url, model: 'story', contextWindow: 20_000, maxOutputTokens: 100, customParameters: {},
  });
  const promptId = store.saveLibrary(store.libraryRevision(), 'prompts', { name: 'With pins', blocks: promptBlocks });
  const contextPresetId = store.saveLibrary(store.libraryRevision(), 'contexts', { ...defaultContextPreset, minTail: 1, batchSize: 1 });
  const id = store.createChat({ title: 'The ferry', targetInputTokens: 10_000, connectionId, promptId, characterId: null, personaId: null, contextPresetId });
  const state = (branch: string = id) => store.engineSnapshot(branch);
  const pin = (turnId: string, pinned: boolean, revision = state().revision, branch: string = id) => command('PUT', `${branch}/turns/${turnId}/pin`, { revision, pinned });
  const list = async (branch: string = id) => (await command('GET', `${branch}/pins`)).json<PinList>();
  const preview = async (text?: string) => (await command('POST', `${id}/preview`, { revision: state().revision, inspection: true, text })).json<RequestPreview>();
  const idle = () => expect.poll(() => coordinator.hasActiveWork()).toBe(false);
  return { store, mock, coordinator, id, state, pin, list, preview, idle, command, connectionId, promptId };
}

async function restoreBackup(source: Store) {
  const targetPath = filename('target');
  const destination = new Store(targetPath);
  close.push(() => destination.close());
  const sourceBackup = new BackupService(source, ':memory:');
  close.push(() => sourceBackup.close());
  const targetBackup = new BackupService(destination, targetPath);
  close.push(() => targetBackup.close());
  const file = await sourceBackup.export();
  try {
    const owner = 'synthetic-owner';
    const review = await targetBackup.inspect(Readable.from([readFileSync(file.path)]), owner);
    targetBackup.commit(review.stageId, owner, { requestId: randomUUID(), digest: review.digest, token: review.token, overwrite: true });
    return destination;
  } finally { file.cleanup(); }
}

test('measures and sends exact grouped excerpts through the mock endpoint, preserving old requests on variant changes and unpin', async () => {
  const f = await fixture();
  seedTranscript(f.store, f.state().revision, f.id, fixtures);
  const [opening, promise, last] = f.state().turns;
  const memory: SummaryNode = {
    id: randomUUID(), revision: 0, level: 1, text: 'The bell signaled the start of the crossing.',
    turns: [sourceOf(opening)], children: [], prior: [], approved: true, manual: false, createdAt: new Date().toISOString(),
  };
  f.store.sqlite.prepare('INSERT INTO summaries (id, revision, chat_id, data) VALUES (?, ?, ?, ?)').run(memory.id, 0, f.id, JSON.stringify(memory));
  f.store.sqlite.prepare('INSERT INTO context_states VALUES (?, ?, ?)').run(f.id, 1, JSON.stringify({ selected: [{ id: memory.id, revision: 0 }], archivedTurnIds: [opening.id] }));
  const before = f.state();
  for (const turn of [opening, promise, last]) expect((await f.pin(turn.id, true)).statusCode).toBe(200);
  expect(f.mock.requests).toHaveLength(0);
  expect(f.state().context).toEqual(before.context);
  expect(f.state().loreState).toEqual(before.loreState);
  expect(f.state().turns.map(sourceOf)).toEqual(before.turns.map(sourceOf));
  const regen = await f.command('POST', `${f.id}/turns/${last.id}/regenerate`, { revision: f.state().revision, requestId: randomUUID() });
  expect(regen.statusCode, regen.body).toBe(202);
  await f.idle();
  const pinnedOpeningAndPromise = `${excerptIntro}\n\n[Turn 1]\n\nAssistant:\nThe opening bell rings.\n\n[Turn 2]\n\nUser:\nI promised the keeper a {{char}} key.\n\nAssistant:\nThe keeper agreed.`;
  expect(f.mock.requests[0]?.body.messages).toEqual([
    { role: 'system', content: '[Memory L1 · turns 1–1]\nThe bell signaled the start of the crossing.' },
    { role: 'system', content: pinnedOpeningAndPromise },
    { role: 'user', content: fixtures[1].user },
    { role: 'assistant', content: 'The keeper agreed.' },
    { role: 'user', content: fixtures[2].user },
  ]);
  const savedRegeneration = f.store.snapshot(f.id).generations[0];
  expect(savedRegeneration.status).toBe('succeeded');
  expect(savedRegeneration.request?.body).toEqual(f.mock.requests[0]?.body);
  expect((await f.preview()).body.messages[1].content).toContain('The lantern flickers.');
  const previousVariant = last.assistant.variantId;
  if (!previousVariant) throw new Error('Missing original selected reply');
  f.store.selectVariant(f.state().revision, last.id, previousVariant, f.id);
  expect((await f.preview()).body.messages[1].content).toContain(fixtures[2].assistant);

  for (const managed of [true, false]) {
    const blocks = promptBlocks.map(block => ({ ...block, enabled: managed || block.id !== 'summary' }));
    const promptId = f.store.saveLibrary(f.store.libraryRevision(), 'prompts', { name: managed ? 'Managed' : 'Summary off', blocks });
    f.store.updateChat(f.state().revision, f.id, { ...f.state().settings, promptId, connectionId: f.connectionId, characterId: null, personaId: null });
    const text = managed ? 'I open the ferry gate.' : 'I ask about the bell.';
    const preview = await f.preview(text);
    const block = preview.layout?.find(part => part.kind === 'pinned');
    expect(block?.pinnedSources).toEqual([opening.id, promise.id, last.id].map((turnId, index) => ({ turnId, ordinal: index + 1 })));
    const estimate = (await f.command('POST', `${f.id}/preview`, { revision: f.state().revision, detail: 'estimate', inspection: true, text })).json<RequestEstimate>();
    expect(estimate.allocations.pinned).toBe(block?.tokens);
    expect(estimate.budget).toEqual(preview.budget);
    expect(preview.budget.inputTokens).toBe(estimateInputTokens(preview.body.messages));
    const send = await f.command('POST', `${f.id}/turns`, { revision: f.state().revision, requestId: randomUUID(), text });
    expect(send.statusCode, send.body).toBe(202);
    await f.idle();
    expect(f.mock.requests.at(-1)?.body).toEqual(preview.body);
    expect(f.store.snapshot(f.id).generations[0].request?.body).toEqual(preview.body);
  }
  expect((await f.pin(opening.id, false)).statusCode).toBe(200);
  expect(f.mock.requests).toHaveLength(3);
  expect(f.store.generation(savedRegeneration.id)?.request).toEqual(savedRegeneration.request);
  const restored = await restoreBackup(f.store);
  expect(restored.generation(savedRegeneration.id)?.request).toEqual(savedRegeneration.request);
});

test('keeps branch membership durable across stale commands, copies, Clear memory, deletion, transcript import and backup', async () => {
  const f = await fixture();
  seedTranscript(f.store, f.state().revision, f.id, [...fixtures, { user: 'Waiting', assistant: '', complete: false }]);
  const [opening, promise, last, pending] = f.state().turns;
  const before = f.state();
  const wrongEpoch = await f.command('PUT', `${f.id}/turns/${opening.id}/pin`, { revision: before.revision, pinned: true }, 'old-dataset');
  expect(wrongEpoch.json().code).toBe('dataset_changed');
  expect((await f.pin(pending.id, true)).json().code).toBe('pin_unavailable');
  const simultaneous = await Promise.all([f.pin(opening.id, true, before.revision), f.pin(promise.id, true, before.revision)]);
  expect(simultaneous.map(response => response.statusCode).sort()).toEqual([200, 409]);
  expect((await f.list()).turns).toHaveLength(1);
  for (const turn of [opening, promise, last]) expect((await f.pin(turn.id, true)).statusCode).toBe(200);
  const currentRevision = f.state().revision;
  expect((await f.pin(last.id, true)).json().revision).toBe(currentRevision);
  const story = (await f.command('GET', `${f.id}/story?limit=1`)).json<StorySnapshot>();
  expect(story.page.turns.map(turn => turn.id)).toEqual([pending.id]);
  expect(story.pinCount).toBe(3);
  expect((await f.list()).turns.map(turn => [turn.ordinal, turn.id])).toEqual([[1, opening.id], [2, promise.id], [3, last.id]]);

  const copy = async (name: string, through?: string) => {
    const response = await f.command('POST', `${f.id}/branches`, { revision: f.state().revision, requestId: randomUUID(), name, through });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ id: string }>().id;
  };
  const fork = await copy('At the promise', promise.id);
  const duplicate = await copy('Whole story');
  const forkPins = (await f.list(fork)).turns;
  expect(forkPins.map(turn => turn.ordinal)).toEqual([1, 2]);
  expect(forkPins[1].id).not.toBe(promise.id);
  expect((await f.list(duplicate)).turns.map(turn => turn.ordinal)).toEqual([1, 2, 3]);
  expect((await f.pin(forkPins[1].id, false, f.state(fork).revision, fork)).statusCode).toBe(200);
  expect((await f.list()).turns).toHaveLength(3);

  const clear = await f.command('POST', `${f.id}/context/clear`, { revision: f.state().revision });
  expect(clear.statusCode, clear.body).toBe(200);
  expect((await f.list()).turns).toHaveLength(3);
  const deleted = await f.command('DELETE', `${f.id}/turns/${promise.id}`, { revision: f.state().revision });
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect((await f.list()).turns.map(turn => [turn.ordinal, turn.id])).toEqual([[1, opening.id], [2, last.id]]);

  const destination = await restoreBackup(f.store);
  expect(destination.readTurns(f.id)).toEqual(f.state().turns);
  expect(destination.readTurns(fork)).toEqual(f.state(fork).turns);
  const imported = f.store.importBranch(f.id, { name: 'Transcript only', requestId: randomUUID(), turns: fixtures });
  expect((await f.list(imported.id)).turns).toEqual([]);
  expect((await f.list()).turns.map(turn => turn.id)).toEqual([opening.id, last.id]);
  expect((await f.list(duplicate)).turns).toHaveLength(3);
  expect(f.mock.requests).toHaveLength(0);
});

test('upgrades populated schema 16 with no pins and keeps later pins after reopen', () => {
  const path = filename('upgrade');
  const store = new Store(path);
  const prompt = store.saveLibrary(store.libraryRevision(), 'prompts', { name: 'Saved layout', blocks: promptBlocks.filter(block => block.id !== 'pinned-messages') });
  const branch = store.createChat({ title: 'Older story', targetInputTokens: 500, connectionId: null, promptId: prompt, characterId: null, personaId: null });
  seedTranscript(store, store.engineSnapshot(branch).revision, branch, fixtures);
  const before = store.engineSnapshot(branch);
  removePinSchema(store.sqlite);
  store.sqlite.pragma('user_version = 16');
  store.close();
  const upgraded = new Store(path);
  try {
    expect(upgraded.engineSnapshot(branch)).toEqual(before);
    upgraded.setTurnPin(branch, before.turns[1].id, before.revision, true);
  } finally { upgraded.close(); }
  const reopened = new Store(path);
  try {
    expect(reopened.pinCount(branch)).toBe(1);
    expect(reopened.readTurns(branch)[1]).toEqual({ ...before.turns[1], pinned: true });
  } finally { reopened.close(); }
});

test('compacts a pinned turn normally and rejects impossible required input before another model call', async () => {
  const f = await fixture();
  const long = 'The lantern waited at the western gate. '.repeat(130);
  seedTranscript(f.store, f.state().revision, f.id, [{ user: long, assistant: 'The gate shut.', complete: true }, ...fixtures]);
  const first = f.state().turns[0];
  expect((await f.pin(first.id, true)).statusCode).toBe(200);
  const full = await f.preview();
  const target = (value: number) => f.store.updateChat(f.state().revision, f.id, {
    ...f.state().settings, connectionId: f.connectionId, promptId: f.promptId, characterId: null, personaId: null, targetInputTokens: value,
  });
  target(full.budget.inputTokens - 150);
  const plan = contextPlan(f.state());
  expect(plan.next?.turnIds).toEqual([first.id]);
  const prepare = () => f.command('POST', `${f.id}/context/prepare`, { revision: f.state().revision, requestId: randomUUID(), mode: 'prepare' });
  const started = await prepare();
  expect(started.statusCode, started.body).toBe(202);
  await f.idle();
  expect(f.state().context.archivedTurnIds).toEqual([first.id]);
  expect(f.mock.requests).toHaveLength(1);
  expect(JSON.stringify(f.mock.requests[0]?.body)).not.toContain(excerptIntro);
  expect((await f.preview()).layout?.find(part => part.kind === 'pinned')?.pinnedSources).toEqual([{ turnId: first.id, ordinal: 1 }]);
  target(200);
  const blocked = (await f.command('GET', `${f.id}/context/plan`)).json<ContextPlan>();
  expect(blocked).toMatchObject({ next: null, blockedMessage: { key: 'pins.required_budget' } });
  const failed = await prepare();
  expect(failed.statusCode, failed.body).toBe(202);
  await f.idle();
  expect(f.mock.requests).toHaveLength(1);
  expect(f.state().context.archivedTurnIds).toEqual([first.id]);

  expect((await f.pin(first.id, false)).statusCode).toBe(200);
  expect(f.state().context.archivedTurnIds).toEqual([first.id]);
  target(full.budget.inputTokens);
  expect((await prepare()).statusCode).toBe(202);
  await f.idle();
  expect(f.state().context.archivedTurnIds).toEqual([]);
  expect(f.mock.requests).toHaveLength(1);
});

test('guards pins during generation and review, and retries the same pending input once', async () => {
  const f = await fixture();
  seedTranscript(f.store, f.state().revision, f.id, fixtures.slice(0, 1));
  const completed = f.state().turns[0];
  f.mock.setMode('hold-first-token');
  const text = 'My pending input appears once.';
  const attempt = f.coordinator.start(f.state().revision, randomUUID(), text, f.id).generationId;
  await expect.poll(() => f.mock.requests.length).toBe(1);
  expect((await f.pin(completed.id, true)).json().code).toBe('generation_running');
  expect((await f.list()).turns).toEqual([]);
  f.coordinator.cancel(attempt);
  await f.idle();

  const pending = f.state().turns.at(-1);
  if (!pending) throw new Error('Missing pending turn');
  expect((await f.pin(pending.id, true)).json().code).toBe('pin_unavailable');
  expect((await f.pin(completed.id, true)).statusCode).toBe(200);
  f.mock.setMode('normal');
  const retry = f.coordinator.start(f.state().revision, randomUUID(), undefined, f.id).generationId;
  await f.idle();
  expect(f.store.generation(retry)).toMatchObject({ turnId: pending.id, status: 'succeeded' });
  expect(f.mock.requests[1]?.body.messages).toEqual([
    { role: 'system', content: `${excerptIntro}\n\n[Turn 1]\n\nAssistant:\nThe opening bell rings.` },
    { role: 'assistant', content: fixtures[0].assistant },
    { role: 'user', content: text },
  ]);
  const { job } = f.store.contexts.begin(f.id, f.state().revision, randomUUID(), 'repair');
  // Represent an outstanding review without invoking a summarizer. Pinning
  // must leave its captured branch revision and review state available.
  f.store.sqlite.prepare("UPDATE context_jobs SET data = json_set(data, '$.status', 'awaiting_review') WHERE id = ?").run(job.id);
  const revision = f.state().revision;
  expect((await f.pin(completed.id, false)).json().code).toBe('repair_awaits_review');
  expect(f.state().revision).toBe(revision);
  expect(f.store.contexts.job(job.id).status).toBe('awaiting_review');
  expect((await f.list()).turns.map(turn => turn.id)).toEqual([completed.id]);
});
