import { useRef, useState } from 'react';
import { z } from 'zod';
import { trimBoundaryNewlines } from '../shared/text';

const submissionSchema = z.object({ requestId: z.string().uuid(), revision: z.number().int().nonnegative(), text: z.string() });
const draftSchema = z.object({ text: z.string(), editId: z.string().uuid(), submission: submissionSchema.nullable() });
type Draft = z.infer<typeof draftSchema>;
type Entry = { draft: Draft; storageError: boolean };
const key = (chatId: string) => `roleplay-draft:${chatId}`;
const emptyDraft = (): Draft => ({ text: '', editId: crypto.randomUUID(), submission: null });

// Save during the input event: unload/debounce callbacks may never run on a suspended phone.
export function useChatDraft(chatId: string | null) {
  const entries = useRef(new Map<string, Entry>());
  const [, render] = useState(0);
  function entry(id: string): Entry {
    const cached = entries.current.get(id);
    if (cached) return cached;
    let loaded: Entry;
    try {
      const stored = localStorage.getItem(key(id));
      loaded = { draft: stored === null ? emptyDraft() : draftSchema.parse(JSON.parse(stored)), storageError: false };
    } catch {
      loaded = { draft: emptyDraft(), storageError: true };
    }
    entries.current.set(id, loaded);
    return loaded;
  }
  function save(id: string, draft: Draft) {
    let storageError = false;
    try { localStorage.setItem(key(id), JSON.stringify(draft)); }
    catch { storageError = true; }
    entries.current.set(id, { draft, storageError });
    render(value => value + 1);
  }
  function change(text: string) {
    if (chatId) save(chatId, { text, editId: crypto.randomUUID(), submission: null });
  }
  function stage(id: string, revision: number) {
    const current = entry(id).draft;
    const text = trimBoundaryNewlines(current.text);
    const submission = current.submission ?? { requestId: crypto.randomUUID(), revision, text };
    const draft = { ...current, submission };
    save(id, draft);
    return draft;
  }
  function acknowledge(id: string, sent: Draft) {
    const current = entry(id).draft;
    if (current.editId !== sent.editId || current.submission?.requestId !== sent.submission?.requestId) return;
    // Another tab may have saved newer text while this request was in flight.
    try {
      const stored = localStorage.getItem(key(id));
      if (stored && draftSchema.parse(JSON.parse(stored)).editId !== sent.editId) {
        entries.current.delete(id);
        render(value => value + 1);
        return;
      }
    } catch { /* The in-memory draft still survives unavailable storage. */ }
    save(id, emptyDraft());
  }
  function reject(id: string, sent: Draft) {
    const current = entry(id).draft;
    if (current.editId === sent.editId && current.submission?.requestId === sent.submission?.requestId) {
      save(id, { ...current, submission: null });
    }
  }
  const current = chatId ? entry(chatId) : null;
  return { text: current?.draft.text ?? '', storageError: current?.storageError ?? false, change, stage, acknowledge, reject };
}
