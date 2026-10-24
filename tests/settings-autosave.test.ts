import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/web/api';
import { SettingsAutosave } from '../src/web/settings-autosave';

type Settings = { color: string; scale: number };
type Status = { revision: number; settings: Settings };
const initial: Status = { revision: 0, settings: { color: 'blue', scale: 100 } };
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(write: (value: Status) => Promise<Status>, read: () => Promise<Status> = async () => initial) {
  const committed = vi.fn();
  const transport = { write: vi.fn(write), read: vi.fn(read), committed };
  return { autosave: new SettingsAutosave<Settings, Status>(initial, transport), ...transport };
}
async function idle(autosave: SettingsAutosave<Settings, Status>) {
  await vi.waitFor(() => expect(autosave.getSnapshot().saving).toBe(false));
}

describe('application settings autosave', () => {
  it('starts immediately, serializes rapid edits and keeps newer choices through delayed responses and navigation', async () => {
    const first = deferred<Status>();
    const { autosave, write, committed } = fixture(async value => write.mock.calls.length === 1 ? first.promise : { ...value, revision: value.revision + 1 });
    const unsubscribe = autosave.subscribe(vi.fn());
    autosave.update({ scale: 110 });
    expect(write).toHaveBeenCalledWith({ revision: 0, settings: { color: 'blue', scale: 110 } });
    autosave.update({ color: 'red' });
    autosave.update({ scale: 120 });
    expect(write).toHaveBeenCalledTimes(1);
    expect(autosave.getSnapshot().draft).toEqual({ color: 'red', scale: 120 });
    // Leaving the settings page removes its observer, but accepted edits still finish.
    unsubscribe();
    first.resolve({ revision: 1, settings: { color: 'blue', scale: 110 } });
    await idle(autosave);
    expect(write.mock.calls[1]).toEqual([{ revision: 1, settings: { color: 'red', scale: 120 } }]);
    expect(committed).toHaveBeenLastCalledWith({ revision: 2, settings: { color: 'red', scale: 120 } });
    expect(autosave.getSnapshot().draft).toEqual({ color: 'red', scale: 120 });
  });

  it('rebases changed fields on the latest revision without overwriting other windows’ settings', async () => {
    const { autosave, write } = fixture(async value => {
      if (value.revision === 0) throw new ApiError('Conflict', 409);
      return { ...value, revision: value.revision + 1 };
    }, async () => ({ revision: 1, settings: { color: 'green', scale: 100 } }));
    autosave.update({ scale: 120 });
    await idle(autosave);
    expect(write).toHaveBeenLastCalledWith({ revision: 1, settings: { color: 'green', scale: 120 } });
    expect(autosave.getSnapshot().error).toBeNull();
  });

  it('retains failed edits, stops automatic retry and reconciles an uncertain commit before explicit retry', async () => {
    const failed = deferred<Status>();
    const saved = { revision: 1, settings: { color: 'blue', scale: 110 } };
    const { autosave, write } = fixture(() => failed.promise, async () => saved);
    autosave.update({ scale: 110 });
    autosave.update({ scale: 120 });
    failed.reject(new Error('Connection lost'));
    await idle(autosave);
    expect(autosave.getSnapshot().draft?.scale).toBe(120);
    expect(autosave.getSnapshot().status).toEqual(initial);
    expect(write).toHaveBeenCalledTimes(1);
    write.mockImplementation(async value => ({ ...value, revision: value.revision + 1 }));
    await autosave.retry();
    expect(write).toHaveBeenLastCalledWith({ revision: 1, settings: { color: 'blue', scale: 120 } });
    expect(autosave.getSnapshot().error).toBeNull();
  });

  it('recognizes an already committed edit after a lost response without another write', async () => {
    const saved = { revision: 1, settings: { color: 'red', scale: 100 } };
    const { autosave, write } = fixture(async () => { throw new Error('Lost response'); }, async () => saved);
    autosave.update({ color: 'red' });
    await idle(autosave);
    await autosave.retry();
    expect(write).toHaveBeenCalledTimes(1);
    expect(autosave.getSnapshot()).toMatchObject({ status: saved, error: null });
  });

  it('ignores stale reads and revisions after a save, and preserves errors during background refresh', async () => {
    const stale = deferred<Status>();
    const { autosave, read } = fixture(async value => ({ ...value, revision: value.revision + 1 }), () => stale.promise);
    const refreshing = autosave.refresh();
    autosave.update({ scale: 120 });
    await idle(autosave);
    stale.reject(new Error('Obsolete read'));
    await refreshing;
    autosave.observe(initial);
    expect(autosave.getSnapshot()).toMatchObject({ draft: { scale: 120 }, error: null });
    read.mockRejectedValueOnce(new Error('Read failed'));
    await autosave.refresh();
    expect(autosave.getSnapshot().error).toBeInstanceOf(Error);
    read.mockResolvedValueOnce({ revision: 1, settings: { color: 'blue', scale: 120 } });
    await autosave.refresh();
    expect(autosave.getSnapshot().error).toBeNull();
  });

  it('allows explicit listener recovery even when the settings already match', async () => {
    const { autosave, write } = fixture(async value => ({ ...value, revision: value.revision + 1 }));
    autosave.update(initial.settings, true);
    await idle(autosave);
    expect(write).toHaveBeenCalledWith(initial);
    expect(autosave.getSnapshot().status?.revision).toBe(1);
    write.mockRejectedValueOnce(new Error('Listener unavailable'));
    autosave.update(initial.settings, true);
    await idle(autosave);
    expect(autosave.getSnapshot().error).toBeInstanceOf(Error);
    await autosave.retry();
    expect(write).toHaveBeenCalledTimes(3);
    expect(autosave.getSnapshot().error).toBeNull();
  });

  it('does not loop on non-revision conflicts or a repeated competing write', async () => {
    for (const revision of [0, 1]) {
      const { autosave, write } = fixture(async () => { throw new ApiError('Unavailable', 409); }, async () => ({ ...initial, revision }));
      autosave.update({ color: 'red' });
      await idle(autosave);
      expect(write).toHaveBeenCalledTimes(revision === 0 ? 1 : 2);
      expect(autosave.getSnapshot()).toMatchObject({ draft: { color: 'red' }, error: expect.any(ApiError) });
    }
  });
});
