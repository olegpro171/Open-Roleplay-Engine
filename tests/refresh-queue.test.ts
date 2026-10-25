import { expect, it } from 'vitest';
import { RefreshQueue, scopeForChange, type RefreshScope } from '../src/web/refresh-queue';

it('serializes reads and merges notifications without losing a changed domain', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reads: RefreshScope[] = [];
  const queue = new RefreshQueue(async scope => {
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
  const queue = new RefreshQueue(async scope => { reads.push(scope); if (reads.length === 1) await gate; });
  const initial = queue.request({ story: true });
  await Promise.resolve();
  release();
  queueMicrotask(() => queueMicrotask(() => { void queue.request({ appearance: true }); }));
  await initial;
  expect(reads).toEqual([{ story: true }, { appearance: true }]);
});
