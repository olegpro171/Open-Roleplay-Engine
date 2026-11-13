import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { repairQueue, selectedContext, sourceOf } from '../src/core/context.js';
import { assembleRequest } from '../src/core/prompt.js';
import { validateContent } from '../src/persistence/backup-validation.js';
import { Store } from '../src/persistence/store.js';
import { GenerationCoordinator } from '../src/server/coordinator.js';
import type { Provider } from '../src/provider/openai.js';
import { defaultContextPreset, refKey } from '../src/shared/context.js';
import { summaryFileSchema } from '../src/shared/summary-file.js';
import { compactPrompt } from './support/compact-prompt.js';
import { seedTranscript } from './support/transcript-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ore-summary-file-'));
  const database = join(directory, 'test.sqlite');
  let store = new Store(database);
  const connection = { name: 'Test', endpoint: 'http://localhost:1234/v1', model: 'test',
    contextWindow: 100_000, maxOutputTokens: 1_000, customParameters: {} };
  store.saveLibrary(store.libraryRevision(), 'prompts', compactPrompt, 'default');
  const connectionId = store.saveLibrary(store.libraryRevision(), 'connections', connection, undefined, 'secret-key');
  const contextPresetId = store.saveLibrary(store.libraryRevision(), 'contexts', {
    ...defaultContextPreset, batchSize: 1, minTail: 0, promotionGroup: 2, retainedPerLevel: 0,
  });
  const settings = { title: 'Test', targetInputTokens: 45, connectionId, contextPresetId,
    promptId: 'default', characterId: null, personaId: null };
  const chatId = store.createChat(settings);
  const other = store.createChat({ ...settings, title: 'Another branch' });
  const state = () => store.engineSnapshot(chatId);
  const original = Array.from({ length: 2 }, (_, i) => ({
    user: `Private transcript turn ${i + 1}. ${'The rain falls on the roof. '.repeat(100)}`,
    assistant: 'Leon picks up the brass key.', complete: true,
  }));
  seedTranscript(store, state().revision, chatId, original);
  seedTranscript(store, store.chatHeader(other).revision, other, original.slice(0, 1));
  let calls = 0;
  const provider: Provider = { async stream(_request, _apiKey, _signal, onText) {
    onText(++calls === 3 ? 'Leon has the key.' : 'Mira gives Leon the brass key for the cellar.');
    return { finishReason: 'stop' };
  } };
  let coordinator = new GenerationCoordinator(store, provider);
  async function step() {
    const { jobId } = coordinator.context.start(chatId, state().revision, randomUUID(), 'step');
    await expect.poll(() => store.contexts.job(jobId).status).not.toBe('running');
    const job = store.contexts.job(jobId);
    expect(job.status, job.error ?? undefined).toBe('succeeded');
    return store.contexts.details(jobId).steps[0];
  }
  const exportFile = () => summaryFileSchema.parse(JSON.parse(JSON.stringify(store.contexts.exportSummaries(chatId, state().revision).file)));
  cleanup.push(async () => { await coordinator.shutdown(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, get coordinator() { return coordinator; }, chatId, other, state, step, exportFile,
    get calls() { return calls; },
    async reopen() {
      await coordinator.shutdown();
      store.close();
      store = new Store(database);
      coordinator = new GenerationCoordinator(store, provider);
    },
  };
}

it('replaces all versions and accepts edited layered memory against the current transcript without model calls', async () => {
  const f = fixture();
  const extraction = await f.step();
  await f.step();
  const promotion = await f.step();
  const before = f.state();
  const child = before.context.summaries.find(node => node.level === 1);
  if (!child) throw new Error('Expected a child summary');
  f.store.contexts.editSummary(f.chatId, before.revision, { id: child.id, revision: child.revision }, 'Mira lends Leon a silver key.');
  f.store.editPart(f.state().revision, before.turns[0].id, 'user', 'Mira gives Leon her iron key.', f.chatId);
  expect(repairQueue(f.state().turns, f.state().context).length).toBeGreaterThan(0);
  const file = f.exportFile();
  expect(file.summaries).toHaveLength(4);
  expect(JSON.stringify(file)).not.toMatch(/Private transcript|secret-key|chat\/completions/);
  const edited = '  Leon has the iron key.\n\nHe must return it by dawn.  ';
  file.summaries.find(node => node.level === 2)!.text = edited;
  // An externally reviewed file can retain literal prose that resembles a refusal.
  file.summaries.find(node => node.manual)!.text = "I can't help with this. Leon is bound by his promise.";
  file.summaries.reverse();
  const { revision, turns } = f.state();
  const review = f.store.contexts.importSummaries(f.chatId, revision, file);
  expect(review).toMatchObject({ existingVersions: 4, importedVersions: 4, archivedTurns: 2 });
  expect(f.state().revision).toBe(revision);
  f.store.contexts.importSummaries(f.chatId, revision, file, review.token);
  const after = f.state();
  expect(after.revision).toBe(revision + 1);
  expect(after.turns).toEqual(turns);
  expect(after.turns[0].user.text).toBe('Mira gives Leon her iron key.');
  expect(after.context.summaries).toHaveLength(4);
  expect(after.context.summaries.every(node => !file.summaries.some(old => old.id === node.id))).toBe(true);
  const selected = selectedContext(after.turns, after.context).summaries;
  expect(selected[0].text).toBe(edited);
  const currentChild = after.context.summaries.find(node => node.manual);
  expect(currentChild).toMatchObject({ revision: 1, turns: [sourceOf(after.turns[0])] });
  expect(currentChild?.refusalCheck).toMatchObject({ result: 'suspected', decision: 'keep' });
  expect(selected[0].children.map(refKey)).toContain(refKey(currentChild!));
  expect(repairQueue(after.turns, after.context)).toEqual([]);
  const request = assembleRequest(after.connection!, after.settings, after.turns, after.sources, after.context, { validateLimits: false });
  expect(request.body.messages.some(message => message.content.endsWith(edited))).toBe(true);
  for (const saved of [extraction, promotion]) {
    expect(f.store.contexts.details(saved.jobId).steps[0]).toEqual({ ...saved, resultDeleted: true });
  }
  expect(f.calls).toBe(3);
  expect(() => validateContent(f.store.sqlite)).not.toThrow();
  await f.reopen();
  expect(f.state().context.selected).toEqual(after.context.selected);
  expect(f.exportFile().summaries.some(node => node.text === edited)).toBe(true);
  expect(() => f.store.contexts.importSummaries(f.chatId, revision, file, review.token)).toThrow(expect.objectContaining({ code: 'revision_conflict' }));
  f.store.editPart(f.state().revision, after.turns[0].id, 'user', 'Mira keeps the key.', f.chatId);
  // The second leaf consumed the first as prior memory. Both precede the parent.
  expect(repairQueue(f.state().turns, f.state().context).map(operation => operation.level)).toEqual([1, 1, 2]);
  expect(f.calls).toBe(3);
});

it('rejects invalid references and stale or tampered reviews and rolls back a failed replace', async () => {
  const f = fixture();
  const step = await f.step();
  const file = f.exportFile();
  const original = f.state();
  const revision = original.revision;
  const review = f.store.contexts.importSummaries(f.chatId, revision, file);
  const badGraph = structuredClone(file);
  badGraph.summaries[0].prior = [badGraph.selected[0]];
  expect(() => f.store.contexts.importSummaries(f.chatId, revision, badGraph)).toThrow(expect.objectContaining({ code: 'invalid_summary_file' }));
  const badCoverage = structuredClone(file);
  badCoverage.archivedTurnIds.reverse();
  badCoverage.archivedTurnIds.push(original.turns[1].id);
  expect(() => f.store.contexts.importSummaries(f.chatId, revision, badCoverage)).toThrow(expect.objectContaining({ code: 'invalid_summary_file' }));
  expect(() => f.store.contexts.importSummaries(f.other, f.store.chatHeader(f.other).revision, file)).toThrow(expect.objectContaining({ code: 'summary_file_branch' }));
  const tampered = structuredClone(file);
  tampered.summaries[0].text = 'Changed after review.';
  expect(() => f.store.contexts.importSummaries(f.chatId, revision, tampered, review.token)).toThrow(expect.objectContaining({ code: 'summary_import_changed' }));

  f.store.sqlite.exec("CREATE TEMP TRIGGER fail_summary_import BEFORE INSERT ON summaries BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END");
  expect(() => f.store.contexts.importSummaries(f.chatId, revision, file, review.token)).toThrow('fixture insert failure');
  expect(f.state()).toEqual(original);
  expect(f.store.contexts.details(step.jobId).steps[0]).toEqual(step);
  f.store.sqlite.exec('DROP TRIGGER fail_summary_import');

  const empty = { ...file, summaries: [], selected: [], archivedTurnIds: [] };
  const emptyReview = f.store.contexts.importSummaries(f.chatId, revision, empty);
  f.store.contexts.importSummaries(f.chatId, revision, empty, emptyReview.token);
  expect(f.state().context).toMatchObject({ summaries: [], selected: [], archivedTurnIds: [] });
  expect(f.state().turns).toEqual(original.turns);
  expect(f.store.contexts.details(step.jobId).steps[0]).toEqual({ ...step, resultDeleted: true });
  expect(f.calls).toBe(1);
});
