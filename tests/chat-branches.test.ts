import { randomUUID } from 'node:crypto';
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { sourceOf } from '../src/core/context.js';
import { Store } from '../src/persistence/store.js';
import { createApp } from '../src/server/app.js';
import { BackupService } from '../src/server/backups.js';
import { defaultAuthorNote } from '../src/shared/author-note.js';
import { defaultContextPreset, type ContextJob, type ContextStep, type SummaryNode } from '../src/shared/context.js';
import { defaultPrompt } from '../src/shared/library.js';
import type { Connection, RequestPreview } from '../src/shared/contracts.js';
import { removeBranchSchema } from './support/schema-15.js';

const connection: Connection = { name: 'Synthetic', endpoint: 'http://localhost:1/v1', model: 'mock',
  contextWindow: 4096, maxOutputTokens: 256, customParameters: {} };

test('forks safely through a turn, reuses fitting saved memory and isolates future edits', async () => {
  const { app, store } = await createApp({ database: ':memory:', provider: {
    async stream() { throw new Error('Branch operations must not call a provider'); },
  } });
  try {
    const host = { host: 'localhost', origin: 'http://localhost' };
    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: host, payload: { password: 'synthetic-branch-password' } });
    const headers = { ...host, cookie: String(setup.headers['set-cookie']).split(';')[0] };
    store.saveLibrary(store.libraryRevision(), 'contexts', { ...defaultContextPreset, batchSize: 1, minTail: 1 }, 'default-context');
    const promptId = store.saveLibrary(store.libraryRevision(), 'prompts', {
      name: 'Memory and messages', blocks: defaultPrompt.blocks
        .filter(block => block.kind === 'marker' && (block.marker === 'summary' || block.marker === 'messages'))
        .map(block => ({ ...block, enabled: true })),
    });
    const setupRevision = store.chatHeader().revision;
    store.saveSettings(setupRevision, connection, { ...store.chatHeader().settings, contextPresetId: 'default-context', promptId,
      targetInputTokens: 850, authorNote: { ...defaultAuthorNote, prompt: 'Current note' } });
    store.replaceHistory(store.chatHeader().revision, 'main', Array.from({ length: 4 }, (_, i) => ({
      user: `Input ${i + 1} ${'keeper '.repeat(560)}`, assistant: `Answer ${i + 1}`, complete: true,
    })));
    const snapshot = store.engineSnapshot();
    const [one, two, three, four] = snapshot.turns;
    if (!one || !two || !three || !four) throw new Error('Missing fixture turns');
    const summary = (text: string, turns: typeof snapshot.turns, options: Partial<SummaryNode> = {}): SummaryNode => ({
      id: randomUUID(), revision: 0, level: 1, text, turns: turns.map(sourceOf), children: [], prior: [],
      approved: true, manual: false, createdAt: new Date().toISOString(), ...options,
    });
    const first = summary('The keeper arrived.', [one]);
    const recent = summary('The keeper examined the bridge.', [two]);
    const crosses = summary('The keeper knows the later outcome.', [two, three], { manual: true });
    const unsafeDependency = summary('The earlier events interpreted using the later outcome.', [one], { prior: [{ id: crosses.id, revision: 0 }] });
    for (const item of [first, recent, crosses, unsafeDependency]) {
      store.sqlite.prepare('INSERT INTO summaries (id,revision,chat_id,data) VALUES (?, ?, ?, ?)').run(item.id, item.revision, 'main', JSON.stringify(item));
    }
    const refs = [first, crosses].map(({ id, revision }) => ({ id, revision }));
    store.sqlite.prepare('INSERT INTO context_states VALUES (?, ?, ?)').run('main', 1, JSON.stringify({
      selected: refs, archivedTurnIds: [one.id, two.id, three.id],
    }));
    const config = snapshot.context.preset;
    if (!config) throw new Error('Missing synthetic context preset');
    const baseline: RequestPreview = {
      endpoint: 'http://localhost:1/v1/chat/completions',
      body: { model: 'mock', stream: true, max_tokens: 256, temperature: 0.35, stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'Original model input' }] },
      coverage: [sourceOf(one)],
      summarySources: [{ turnId: one.id, user: one.user.text, assistant: one.assistant.text }],
      budget: { inputTokens: 20, targetInputTokens: 3840, reservedOutputTokens: 256, contextWindow: 4096, method: 'synthetic', verified: false },
    };
    const job: ContextJob = { id: randomUUID(), chatId: 'main', mode: 'prepare', status: 'succeeded', sourceRevision: snapshot.revision,
      generationId: null, config, stepCount: 1, error: null, historyTurnIds: snapshot.turns.map(turn => turn.id),
      createdAt: first.createdAt, updatedAt: first.createdAt };
    const step: ContextStep = { id: randomUUID(), jobId: job.id, status: 'saved', result: { id: first.id, revision: 0 },
      operation: { level: 1, turnIds: [one.id], children: [] }, request: baseline, error: null,
      before: { archivedTurnIds: [], selected: [] }, after: { archivedTurnIds: [one.id], selected: [{ id: first.id, revision: 0 }] },
      inputBefore: 2000, inputAfter: 1400, createdAt: first.createdAt };
    store.sqlite.prepare('INSERT INTO context_jobs VALUES (?, ?, ?, ?, ?)').run(job.id, 'main', randomUUID(), '{}', JSON.stringify(job));
    store.sqlite.prepare('INSERT INTO context_steps VALUES (?, ?, ?)').run(step.id, job.id, JSON.stringify(step));
    const forkPayload = { revision: snapshot.revision, name: 'Before the outcome', through: two.id, requestId: randomUUID() };
    const fork = () => app.inject({ method: 'POST', url: '/api/chats/main/branches', headers, payload: forkPayload });
    const result = await fork();
    expect(result.statusCode, result.body).toBe(200);
    const id = result.json<{ id: string }>().id;
    expect((await fork()).json()).toEqual({ id });
    const branch = store.engineSnapshot(id);
    expect(branch.turns.map(turn => turn.assistant.text)).toEqual(['Answer 1', 'Answer 2']);
    expect(branch.context.summaries.map(summary => summary.text)).toEqual([first.text, recent.text]);
    const saved = branch.context.summaries[0];
    if (!saved) throw new Error('Missing copied summary');
    expect(branch.context.selected).toEqual([{ id: saved.id, revision: 0 }]);
    expect(branch.context.archivedTurnIds).toEqual([branch.turns[0]?.id]);
    expect(branch.context.jobs).toEqual([]);
    const inherited = store.contexts.sourceRequest(id, saved);
    expect(inherited?.body).toEqual(baseline.body);
    expect(inherited?.summarySources?.[0]?.turnId).toBe(branch.turns[0]?.id);
    expect(branch.settings.authorNote?.prompt).toBe('Current note');
    expect(store.engineSnapshot().context.selected).toEqual(refs);
    const duplicatePayload = { revision: branch.revision, name: 'Independent duplicate', requestId: randomUUID() };
    const duplicate = await app.inject({ method: 'POST', url: `/api/chats/${id}/branches`, headers, payload: duplicatePayload });
    expect(duplicate.statusCode, duplicate.body).toBe(200);
    const copy = duplicate.json<{ id: string }>().id;
    store.saveAuthorNote(id, { revision: branch.revision, settings: { ...defaultAuthorNote, prompt: 'Branch-only note' } });
    expect(store.authorNote(copy).settings.prompt).toBe('Current note');
    store.updateChat(store.chatHeader(id).revision, id, {
      title: 'Shared title', promptId: 'default', connectionId: 'main', characterId: null, personaId: null,
      contextPresetId: 'default-context', targetInputTokens: 1350,
    });
    expect(store.chatHeader(copy).settings.title).toBe('Shared title');
    expect(store.chatHeader().settings.targetInputTokens).toBe(1350);
    store.contexts.clearMemory(id, store.chatHeader(id).revision);
    expect(store.engineSnapshot(id).context.summaries).toEqual([]);
    expect(store.engineSnapshot(copy).context.summaries).toHaveLength(2);
    store.deleteBranch('main', store.chatHeader().revision);
    expect(store.engineSnapshot(copy).turns).toHaveLength(2);
    expect(() => store.deleteChat(store.chatHeader(id).revision, id)).toThrow('branches have changed');

    const sourceBackup = new BackupService(store, ':memory:');
    const restored = new Store(':memory:');
    const destinationBackup = new BackupService(restored, ':memory:');
    try {
      const file = await sourceBackup.export();
      const review = await destinationBackup.inspect(createReadStream(file.path), 'synthetic-owner');
      file.cleanup();
      expect(review.blockers).toEqual([]);
      destinationBackup.commit(review.stageId, 'synthetic-owner', {
        requestId: randomUUID(), token: review.token, digest: review.digest, overwrite: true,
      });
      expect(restored.engineSnapshot(copy)).toEqual(store.engineSnapshot(copy));
      expect(restored.authorNote(id).settings.prompt).toBe('Branch-only note');
      expect(restored.libraries().chats.filter(branch => branch.groupId === 'main')).toHaveLength(2);
    } finally {
      destinationBackup.close();
      restored.close();
      sourceBackup.close();
    }
  } finally { await app.close(); }
});

test('a populated schema 15 chat becomes Main with stable record identities and saved note', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ore-branch-upgrade-'));
  const path = join(directory, 'app.sqlite');
  try {
    const store = new Store(path);
    const revision = store.replaceHistory(0, 'main', [{ user: 'Original', assistant: 'Original reply', complete: true }]);
    store.saveAuthorNote('main', { revision, settings: { ...defaultAuthorNote, prompt: 'Old note' } });
    const before = store.snapshot();
    store.close();
    const previous = new Database(path);
    try { removeBranchSchema(previous); previous.pragma('user_version = 15'); } finally { previous.close(); }
    const upgraded = new Store(path);
    try {
      expect(upgraded.snapshot()).toEqual(before);
      expect(upgraded.libraries().chats).toMatchObject([{ id: 'main', groupId: 'main', branchName: null }]);
    } finally { upgraded.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
