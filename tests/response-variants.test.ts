import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/persistence/store.js';
import { GenerationCoordinator } from '../src/server/coordinator.js';
import type { Provider } from '../src/provider/openai.js';
import type { RequestPreview } from '../src/shared/contracts.js';
import { defaultContextPreset, type SummaryNode } from '../src/shared/context.js';
import { sourceOf, staleSummaries } from '../src/core/context.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error('Missing variant fixture value');
  return value;
}
function fixture(count = 1) {
  const directory = mkdtempSync(join(tmpdir(), 'ore-variants-')), filename = join(directory, 'chat.sqlite');
  let store = new Store(filename);
  const calls: RequestPreview[] = [];
  let output = 'Alternative B.', fail = false, hold = false, release: (() => void) | undefined;
  const provider: Provider = { async stream(request, _key, _signal, onText) {
    calls.push(request);
    if (fail) throw new Error('synthetic upstream failure with secret');
    const text = request.body.model === 'summary' ? 'Mira owns the key.' : output;
    onText(text);
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    return { finishReason: 'stop', usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 } };
  } };
  store.saveSettings(store.snapshot().revision, { name: 'Story', endpoint: 'http://localhost/v1', model: 'story', contextWindow: 100_000, maxOutputTokens: 1000, customParameters: {} }, store.snapshot().settings, 'synthetic-variant-secret');
  store.replaceHistory(store.snapshot().revision, 'main', Array.from({ length: count }, (_, index) => ({ user: `Input ${index}. ${'Old scene detail. '.repeat(count > 1 ? 30 : 0)}`, assistant: index === count - 1 ? 'Original A.' : `Earlier response ${index}. ${'More detail. '.repeat(30)}`, complete: true })));
  let coordinator = new GenerationCoordinator(store, provider);
  const state = () => store.snapshot();
  const regen = (requestId = randomUUID()) => coordinator.regenerate(state().revision, requestId, required(state().turns.at(-1)).id, 'main').generationId;
  const idle = async () => { await expect.poll(() => state().generations[0]?.status, { timeout: 5000 }).not.toBe('running'); };
  const select = (id: string, turnId = required(state().turns.at(-1)).id) => store.selectVariant(state().revision, turnId, id, 'main');
  cleanup.push(async () => { release?.(); await coordinator.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, get coordinator() { return coordinator; }, filename, calls, state, regen, idle, select,
    output(value: string) { output = value; }, fail(value = true) { fail = value; }, hold() { hold = true; }, release() { hold = false; release?.(); },
    async reopen() { release?.(); await coordinator.shutdown(); store.close(); store = new Store(filename); coordinator = new GenerationCoordinator(store, provider); },
  };
}

describe('durable response variants', () => {
  it('keeps exact equal generated text on the same content baseline and rejects a delayed stale result', async () => {
    const f = fixture(), original = f.state().turns[0];
    f.output(original.assistant.text); f.regen(); await f.idle();
    expect(f.state().turns[0].variants).toHaveLength(2);
    expect(f.state().turns[0].assistant.sourceRevision).toBe(original.assistant.sourceRevision);
    const selected = f.state().turns[0];
    f.output('Delayed different response'); f.hold(); f.regen();
    await expect.poll(() => f.state().generations[0].partialText).toBe('Delayed different response');
    // Simulate an intervening revision at the commit boundary, bypassing UI locks.
    f.store.bumpRevision(); f.release(); await f.idle();
    expect(f.state().generations[0].status).toBe('failed');
    expect(f.state().turns[0]).toEqual(selected);
  });
  it('regenerates only the latest turn, excludes its response, selects atomically and preserves per-variant history', async () => {
    const f = fixture(2), before = f.state(), target = before.turns[1], original = required(target.variants?.[0]);
    const requestId = randomUUID(), id = f.regen(requestId);
    expect(f.coordinator.regenerate(before.revision, requestId, target.id, 'main').generationId).toBe(id);
    expect(f.state().turns[1]).toEqual(target);
    await f.idle();
    const after = f.state(), replacement = required(after.turns[1].variants?.[1]);
    expect(after.turns).toHaveLength(2);
    expect(after.turns[1].complete).toBe(true);
    expect(after.turns[1].assistant).toMatchObject({ text: 'Alternative B.', variantId: replacement.id });
    expect(replacement.generationId).toBe(id);
    expect(after.generations[0].usage).toEqual({ inputTokens: 9, outputTokens: 3, totalTokens: 12 });
    expect(f.calls).toHaveLength(1);
    expect(JSON.stringify(f.calls[0].body)).not.toContain('Original A.');
    expect(f.calls[0].body.messages.at(-1)?.content).toBe(target.user.text);
    expect(f.calls[0].coverage.at(-1)).toMatchObject({ complete: false });
    expect(() => f.coordinator.regenerate(after.revision, randomUUID(), before.turns[0].id, 'main')).toThrow('latest completed');
    f.select(original.id);
    expect(f.state().turns[1].assistant.text).toBe('Original A.');
    expect(f.state().turns[1].assistant.revision).toBeGreaterThan(after.turns[1].assistant.revision);
    expect(f.state().turns[1].assistant.sourceRevision).toBe(target.assistant.sourceRevision);
    f.select(replacement.id);
    expect(f.state().generations[0].request).toEqual(after.generations[0].request);
    await f.reopen();
    expect(f.state().turns[1]).toEqual({ ...after.turns[1], assistant: { ...after.turns[1].assistant, revision: after.turns[1].assistant.revision + 2 } });
    expect(JSON.stringify(f.state())).not.toContain('synthetic-variant-secret');
    expect(f.store.sqlite.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps the selected response on failure, empty output, cancellation, late completion and restart', async () => {
    const f = fixture(), original = f.state().turns[0];
    f.fail(); f.regen(); await f.idle();
    expect(f.state().turns[0]).toEqual(original);
    expect(JSON.stringify(f.state())).not.toContain('upstream failure with secret');
    f.fail(false); f.output('  '); f.regen(); await f.idle();
    expect(f.state().generations[0].status).toBe('failed');
    expect(f.state().turns[0]).toEqual(original);
    f.output('Late B.'); f.hold(); const id = f.regen();
    await expect.poll(() => f.state().generations[0].partialText).toBe('Late B.');
    expect(() => f.select(required(original.variants?.[0]).id)).toThrow('current response');
    expect(() => f.coordinator.start(f.state().revision, randomUUID(), 'Another turn')).toThrow('current response');
    f.coordinator.cancel(id); f.release();
    await f.idle(); await f.reopen();
    expect(f.state().turns[0]).toEqual(original);
    // Simulate a process interruption using a persisted running command and no dispatch.
    f.store.beginRegeneration(f.state().revision, randomUUID(), original.id, 'main');
    const count = f.calls.length;
    await f.reopen();
    expect(f.state().generations[0].status).toBe('interrupted');
    expect(f.calls).toHaveLength(count);
    expect(f.state().turns[0]).toEqual(original);
    f.regen(); await f.idle();
    expect(f.state().turns[0].variants).toHaveLength(2);
  });

  it('keeps variants after new turns, protects revisions and chat ownership, and deletes them with the turn', async () => {
    const f = fixture(); f.regen(); await f.idle();
    const target = f.state().turns[0], a = required(target.variants?.[0]), b = required(target.variants?.[1]);
    f.coordinator.start(f.state().revision, randomUUID(), 'Later input'); await f.idle();
    const later = f.state().turns[1];
    f.select(a.id, target.id);
    expect(f.state().turns[1]).toEqual(later);
    expect(() => f.store.selectVariant(0, target.id, b.id, 'main')).toThrow('changed on another device');
    expect(() => f.select(required(later.variants?.[0]).id, target.id)).toThrow('not available');
    const other = f.store.createChat({ title: 'Independent', targetInputTokens: 32000, connectionId: null, promptId: 'default', characterId: null, personaId: null });
    expect(() => f.store.selectVariant(f.store.snapshot(other).revision, target.id, b.id, other)).toThrow('not available');
    const revision = f.state().revision;
    f.select(a.id, target.id); expect(f.state().revision).toBe(revision);
    f.store.deleteTurn(revision, target.id);
    expect(f.store.sqlite.prepare('SELECT * FROM response_variants WHERE turn_id = ?').all(target.id)).toEqual([]);
    expect(f.state().generations.some(generation => generation.turnId === target.id)).toBe(false);
  });

  it('rolls back response selection and the generated variant if a completion write fails', async () => {
    const f = fixture(), original = f.state().turns[0];
    f.store.sqlite.exec("CREATE TRIGGER reject_variant BEFORE INSERT ON response_variants BEGIN SELECT RAISE(ABORT, 'synthetic variant write failure'); END");
    f.regen(); await f.idle();
    expect(f.state().generations[0].status).toBe('failed');
    expect(f.state().turns[0]).toEqual(original);
    f.store.sqlite.exec('DROP TRIGGER reject_variant');
    f.regen(); await f.idle(); expect(f.state().turns[0].variants).toHaveLength(2);
  });

  it('reconstructs an already archived latest turn without changing live selection; A → B → A restores memory', async () => {
    const f = fixture(12);
    const ending = required(f.state().turns.at(-1));
    f.store.editPart(f.state().revision, ending.id, 'user', 'Regenerate input');
    f.store.editPart(f.state().revision, ending.id, 'assistant', 'Original A. ' + 'A long scene ending. '.repeat(300));
    const connectionId = f.store.saveLibrary(f.store.libraryRevision(), 'connections', { name: 'Summary', endpoint: 'http://localhost/v1', model: 'summary', contextWindow: 100000, maxOutputTokens: 1000, customParameters: {} });
    const preset = f.store.saveLibrary(f.store.libraryRevision(), 'contexts', { ...defaultContextPreset, connectionId, minTail: 0, batchSize: 2, promotionGroup: 2, retainedPerLevel: 0 });
    f.store.updateChat(f.state().revision, 'main', { title: 'Archived variants', connectionId: 'main', promptId: 'default', characterId: null, personaId: null, targetInputTokens: 400, contextPresetId: preset });
    const jobId = f.coordinator.context.start('main', f.state().revision, randomUUID(), 'prepare').jobId;
    await expect.poll(() => f.store.contexts.job(jobId).status, { timeout: 5000 }).toBe('succeeded');
    const before = f.state(), target = required(before.turns.at(-1)), steps = f.store.contexts.steps(jobId);
    expect(before.context.archivedTurnIds).toContain(target.id);
    f.regen(); await f.idle();
    expect(f.state().generations[0], JSON.stringify(f.state().generations[0])).toMatchObject({ status: 'succeeded' });
    expect(f.state().context.selected).toEqual(before.context.selected);
    expect(f.state().context.archivedTurnIds).toEqual(before.context.archivedTurnIds);
    expect(staleSummaries(f.state().turns, f.state().context).size).toBeGreaterThan(0);
    const modelCalls = f.calls.length;
    f.select(required(target.variants?.[0]).id);
    expect(f.calls).toHaveLength(modelCalls);
    expect(staleSummaries(f.state().turns, f.state().context).size).toBe(0);
    // Browsing and switching do not rewrite historical preparation inputs.
    expect(f.store.contexts.steps(jobId)).toEqual(steps);
    const consumer = required(before.context.summaries.find(node => node.turns.some(source => source.turnId === target.id)));
    f.store.contexts.editSummary('main', f.state().revision, consumer, 'Manual correction for the ending.');
    expect(() => f.regen()).toThrow('manually corrected');
  });
});

it.each([false, true])('upgrades populated schema 10 atomically and preserves legacy provenance (rollback: %s)', async failMigration => {
  const f = fixture(2);
  f.coordinator.start(f.state().revision, randomUUID(), 'A generated turn'); await f.idle();
  const completed = f.state();
  const generatedTurn = required(completed.turns.at(-1));
  f.store.editPart(f.state().revision, generatedTurn.id, 'assistant', 'An edited generated response');
  const memory: SummaryNode = { id: 'legacy-memory', revision: 0, level: 1, text: 'Prior scene.', turns: completed.turns.slice(0, 2).map(sourceOf), children: [], prior: [], approved: true, manual: false, createdAt: '' };
  f.store.sqlite.prepare('INSERT INTO summaries(id, revision, chat_id, data) VALUES (?, ?, ?, ?)').run(memory.id, 0, 'main', JSON.stringify(memory));
  f.store.sqlite.prepare('INSERT INTO context_states(chat_id, revision, data) VALUES (?, ?, ?)').run('main', 3, JSON.stringify({ selected: [{ id: memory.id, revision: 0 }], archivedTurnIds: memory.turns.map(source => source.turnId) }));
  const pending = f.store.begin(f.state().revision, randomUUID(), 'An unresolved turn');
  f.store.finish(pending.id, 'failed', 'Partial text', 'Synthetic failure');
  const before = f.state();
  await f.coordinator.shutdown();
  const { removeVariantSchema, legacyRows } = await import('./support/legacy-variants.js');
  removeVariantSchema(f.store.sqlite);
  f.store.sqlite.pragma('user_version = 10');
  const tables = ['turns', 'generations', 'chats', 'credentials', 'summaries', 'context_states'];
  const records = Object.fromEntries(tables.map(table => [table, legacyRows(f.store.sqlite, table)]));
  if (failMigration) f.store.sqlite.exec("CREATE TRIGGER reject_variant_migration BEFORE UPDATE ON turns BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END");
  f.store.close();
  if (failMigration) {
    expect(() => new Store(f.filename)).toThrow('synthetic migration failure');
    const db = new Database(f.filename);
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(10);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'response_variants'").get()).toBeUndefined();
      expect(Object.fromEntries(tables.map(table => [table, legacyRows(db, table)]))).toEqual(records);
      db.exec('DROP TRIGGER reject_variant_migration');
    } finally { db.close(); }
  }
  await f.reopen();
  const after = f.state();
  expect(f.store.sqlite.pragma('user_version', { simple: true })).toBe(15);
  expect(Object.fromEntries(tables.map(table => [table, legacyRows(f.store.sqlite, table)]))).toEqual(records);
  expect(after.turns.map(turn => ({ id: turn.id, complete: turn.complete, user: turn.user, text: turn.assistant.text, revision: turn.assistant.revision })))
    .toEqual(before.turns.map(turn => ({ id: turn.id, complete: turn.complete, user: turn.user, text: turn.assistant.text, revision: turn.assistant.revision })));
  expect(after.turns.slice(0, -1).every(turn => turn.variants?.length === 1 && turn.assistant.sourceRevision === turn.assistant.revision)).toBe(true);
  expect(after.turns.at(-1)?.variants).toEqual([]);
  expect(after.generations).toEqual(before.generations);
  expect(after.turns[2].variants?.[0].generationId).toBe(before.generations.find(generation => generation.status === 'succeeded')?.id);
  expect(after.context).toEqual(before.context);
  expect(staleSummaries(after.turns, after.context).size).toBe(0);
  expect(after.revision).toBe(before.revision);
  expect(f.store.sqlite.pragma('foreign_key_check')).toEqual([]);
});
