import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { authorNoteSchema, authorNoteStatusSchema, defaultAuthorNote, type AuthorNote, type AuthorNoteStatus } from '../shared/author-note';
import type { StorySnapshot } from '../shared/transcript';
import { api, datasetChanged, datasetEpoch } from './api';
import { LocalizedError, message } from './localization';
import { SettingsAutosave } from './settings-autosave';

const storedNoteSchema = z.object({ changes: authorNoteSchema.partial() }).strict();
type Entry = {
  editor: SettingsAutosave<AuthorNote, AuthorNoteStatus>;
  restored: Partial<AuthorNote> | null;
  storageError: boolean;
  unsubscribe: (() => void) | null;
  persist: () => void;
};

/** A timed-out write may have committed; SettingsAutosave reconciles before Retry. */
export async function authorNoteRequest(path: string, body?: AuthorNoteStatus): Promise<AuthorNoteStatus> {
  if (datasetChanged()) throw new LocalizedError(message('app.application_data_was_imported_or_wiped_in'));
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15_000);
  try {
    return authorNoteStatusSchema.parse(await api<unknown>(path, body ? 'PUT' : 'GET', body, controller.signal));
  } catch (error) {
    if (controller.signal.aborted) throw new LocalizedError(message('author_note.timeout'));
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export function useAuthorNote(snapshot: StorySnapshot | null, locked: boolean, committed: (id: string, status: AuthorNoteStatus) => void) {
  const entries = useRef(new Map<string, Entry>());
  const callback = useRef(committed);
  callback.current = committed;
  const [, render] = useState(0);
  const [empty] = useState(() => new SettingsAutosave<AuthorNote, AuthorNoteStatus>(null, {
    read: async () => { throw new Error('No selected chat.'); },
    write: async () => { throw new Error('No selected chat.'); },
    committed: () => {},
  }));
  const id = snapshot?.id;
  let entry = id ? entries.current.get(id) : undefined;
  if (id && snapshot && !entry) {
    const key = `ore-author-note:${datasetEpoch()}:${id}`;
    const initial = { revision: snapshot.revision, settings: snapshot.settings.authorNote ?? defaultAuthorNote };
    let restored: Partial<AuthorNote> | null = null;
    let storageError = false;
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) {
        const stored = storedNoteSchema.parse(JSON.parse(raw));
        const patch = stored.changes;
        if (Object.keys(patch).length) restored = patch;
      }
    } catch { storageError = true; }
    const path = `/chats/${id}/author-note`;
    const editor = new SettingsAutosave<AuthorNote, AuthorNoteStatus>(initial, {
      read: () => authorNoteRequest(path), write: value => authorNoteRequest(path, value),
      committed: value => callback.current(id, value),
    });
    const created: Entry = { editor, restored, storageError, unsubscribe: null, persist: () => {} };
    created.persist = () => {
      const state = editor.getSnapshot();
      const previousError = created.storageError;
      try {
        if (state.pending && state.status && state.draft) {
          localStorage.setItem(key, JSON.stringify({ changes: state.pendingChanges }));
        } else if (!created.restored) localStorage.removeItem(key);
        created.storageError = false;
      } catch { created.storageError = true; }
      if (previousError !== created.storageError) render(value => value + 1);
    };
    entry = created;
    entries.current.set(id, created);
  }
  const editor = entry?.editor ?? empty;
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  useEffect(() => {
    if (entry && !entry.unsubscribe) entry.unsubscribe = editor.subscribe(entry.persist);
  }, [editor]);
  useEffect(() => {
    if (!entry || !snapshot) return;
    editor.observe({ revision: snapshot.revision, settings: snapshot.settings.authorNote ?? defaultAuthorNote });
    if (entry.restored && !locked && !datasetChanged()) {
      const patch = entry.restored;
      entry.restored = null;
      editor.update(patch);
    }
  }, [editor, snapshot?.revision, snapshot?.settings.authorNote, locked]);
  useEffect(() => {
    // Retain only the current editor and unresolved saves, including while navigating.
    for (const [otherId, other] of entries.current) {
      if (otherId !== id && !other.restored && !other.editor.getSnapshot().pending) {
        other.unsubscribe?.(); entries.current.delete(otherId);
      }
    }
  }, [id, state.pending]);
  useEffect(() => () => {
    for (const item of entries.current.values()) {
      item.unsubscribe?.();
      item.unsubscribe = null;
    }
  }, []);
  const pending = state.pending || Boolean(entry?.restored);
  return {
    editor, ...state,
    draft: state.draft ? { ...state.draft, ...entry?.restored } : null,
    pending,
    error: pending ? state.error : null,
    storageError: entry?.storageError ?? false,
  };
}
