import { expect, it } from 'vitest';
import { RefreshQueue, scopeForChange, type RefreshRequest, type RefreshScope } from '../src/web/refresh-queue';

it('serializes reads and merges notifications without losing a changed domain', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reads: RefreshScope[] = [];
  const queue = new RefreshQueue(async ({ scope }) => {
    reads.push(scope);
    if (reads.length === 1) await gate;
  });
  const initial = queue.request({ story: true });
  await Promise.resolve();
  const later = [queue.request({ appearance: true }), queue.request({ library: true }), queue.request({ story: true })];
  expect(reads).toEqual([{ story: true }]);
  release();
  await Promise.all([initial, ...later]);
  expect(reads).toEqual([{ story: true }, { appearance: true, library: true, story: true }]);
  await queue.request({ 'chat-behavior': true });
  expect(reads.at(-1)).toEqual({ 'chat-behavior': true });
});

it('reads only the affected chat and settings while preserving library activity updates', () => {
  expect(scopeForChange({ kind: 'chat', chatId: 'other', detail: 'stream' }, 'main')).toBeNull();
  expect(scopeForChange({ kind: 'chat', chatId: 'main', detail: 'stream' }, 'main')).toEqual({ story: true });
  expect(scopeForChange({ kind: 'chat', chatId: 'main', detail: 'stream' }, 'main', false)).toBeNull();
  expect(scopeForChange({ kind: 'chat', chatId: 'other', detail: 'state' }, 'main')).toEqual({ library: true });
  expect(scopeForChange({ kind: 'settings', setting: 'appearance' }, 'main')).toEqual({ appearance: true });
  expect(scopeForChange({ kind: 'library' }, 'main')).toEqual({ library: true, story: true, tools: true });
});

it('does not lose a notification between the last read and queue settlement', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reads: RefreshScope[] = [];
  const queue = new RefreshQueue(async ({ scope }) => { reads.push(scope); if (reads.length === 1) await gate; });
  const initial = queue.request({ story: true });
  await Promise.resolve();
  release();
  queueMicrotask(() => queueMicrotask(() => { void queue.request({ appearance: true }); }));
  await initial;
  expect(reads).toEqual([{ story: true }, { appearance: true }]);
});

it('uses a queued resume as the retry and still drains later notifications', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reads: RefreshRequest[] = [];
  const recovery: boolean[] = [];
  const queue = new RefreshQueue(async request => {
    reads.push(request);
    if (reads.length === 1) {
      await gate;
      recovery.push(queue.retryAfterResume(request));
    } else if (request.resume === 'retry') {
      void queue.request({ appearance: true });
      recovery.push(queue.retryAfterResume(request));
    }
  });
  const initial = queue.request({ story: true });
  await Promise.resolve();
  const resumed = queue.request({ library: true }, 'initial');
  release();
  await Promise.all([initial, resumed]);
  expect(recovery).toEqual([true, false]);
  expect(reads).toEqual([
    { scope: { story: true } },
    { scope: { story: true, library: true }, resume: 'retry' },
    { scope: { appearance: true } },
  ]);
});
