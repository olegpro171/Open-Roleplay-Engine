import { useEffect, useState } from 'react';
import { z } from 'zod';
import { composerDraftReferenceSchema, composerDraftSchema, composerDraftSaveSchema, sameComposerEdit, type ComposerDraft } from '../shared/composer-draft';
import { submissionSchema } from '../shared/contracts';
import { trimBoundaryNewlines } from '../shared/text';
import { api, ApiError, datasetChanged, datasetEpoch } from './api';
import { LocalizedError, message as msg } from './localization';
import { newId } from './uuid';

const localDraftSchema = z.object({
  epoch: z.string().default('initial'), text: z.string(), editId: z.string().uuid(),
  submission: submissionSchema.extend({ text: z.string() }).nullable(),
  editedAfterUnconfirmedSend: z.boolean().optional(),
  sync: z.object({ reference: composerDraftReferenceSchema, pending: z.boolean() }).optional(),
});
type LocalDraft = z.infer<typeof localDraftSchema>;
type Entry = {
  local: LocalDraft;
  remote: ComposerDraft | null;
  storageError: boolean;
  syncError: boolean;
  reading: boolean;
  refreshNeeded: boolean;
  writing: boolean;
  flushNeeded: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

const key = (id: string) => `roleplay-draft:${id}`;
const path = (id: string) => `/chats/${encodeURIComponent(id)}/draft`;
const emptyDraft = (): LocalDraft => ({ epoch: datasetEpoch(), text: '', editId: newId(), submission: null });
const differentDataset = (local: LocalDraft) => local.epoch !== datasetEpoch() && Boolean(local.text || local.submission);
// A send with a lost acknowledgement can advance the server draft while this browser
// is editing its replacement offline. Keep that edit local for explicit recovery.
function reviewReason({ local, remote }: Entry) {
  if (differentDataset(local)) return 'dataset';
  const base = local.sync?.reference.baseRevision;
  if (!local.submission && local.editedAfterUnconfirmedSend && local.sync?.pending
    && remote && base != null && base < remote.sentRevision) return 'send';
  return null;
}
function readLocal(id: string) {
  const stored = localStorage.getItem(key(id));
  return stored === null ? null : localDraftSchema.parse(JSON.parse(stored));
}

class ChatDrafts {
  private readonly entries = new Map<string, Entry>();
  private readonly editorId = newId();
  private sequence = 0;
  private enabled = false;

  constructor(private render: () => void) {}

  enable(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) for (const entry of this.entries.values()) clearTimeout(entry.timer);
  }

  private get active() { return this.enabled && !datasetChanged(); }

  entry(id: string): Entry {
    const cached = this.entries.get(id);
    if (cached) return cached;
    const entry: Entry = {
      local: emptyDraft(), remote: null, storageError: false, syncError: false,
      reading: false, refreshNeeded: false, writing: false, flushNeeded: false,
    };
    try { entry.local = readLocal(id) ?? entry.local; }
    catch { entry.storageError = true; }
    this.entries.set(id, entry);
    return entry;
  }

  private keep(id: string, entry: Entry, local: LocalDraft, background = false) {
    try {
      // A passive read or Send acknowledgement must leave another tab's unsynced work recoverable.
      const stored = background ? readLocal(id) : null;
      const storedIsClean = stored && !stored.submission && (stored.sync?.pending === false || (!stored.sync && !stored.text));
      if (!stored || stored.editId === entry.local.editId || storedIsClean) {
        localStorage.setItem(key(id), JSON.stringify(local));
        entry.storageError = false;
      }
    } catch { entry.storageError = true; }
    entry.local = local;
    this.render();
  }

  private edit(text: string, baseRevision: number | null, epoch = datasetEpoch()): LocalDraft {
    const reference = { baseRevision, edit: { editorId: this.editorId, sequence: ++this.sequence } };
    return { ...emptyDraft(), epoch, text, sync: { reference, pending: true } };
  }

  change(id: string, text: string) {
    const entry = this.entry(id);
    const epoch = differentDataset(entry.local) ? entry.local.epoch : datasetEpoch();
    const afterSend = Boolean(entry.local.submission || entry.local.editedAfterUnconfirmedSend);
    const savedBase = afterSend ? entry.local.sync?.reference.baseRevision : null;
    const base = reviewReason(entry) === 'send' ? savedBase : entry.remote?.revision ?? savedBase;
    const edit = this.edit(text, base ?? null, epoch);
    if (afterSend) edit.editedAfterUnconfirmedSend = true;
    this.keep(id, entry, edit);
    this.schedule(id, entry);
  }

  async replace(id: string, text: string, expectedDraft: number, dismissSuggestionId: string) {
    const entry = this.entry(id);
    if (!this.active || !entry.remote || entry.remote.revision !== expectedDraft || entry.local.sync?.pending || entry.local.submission || reviewReason(entry)) {
      throw new LocalizedError(msg('impersonate.draft_changed'));
    }
    const edit = { editorId: this.editorId, sequence: ++this.sequence };
    try {
      const result = composerDraftSchema.parse(await api(path(id), 'PUT', {
        text, edit, baseRevision: expectedDraft, dismissSuggestionId,
      }, AbortSignal.timeout(8000)));
      if (this.active) this.observe(id, entry, result);
    } catch (error) {
      void this.refresh(id);
      throw error;
    }
  }

  review(id: string) {
    const entry = this.entry(id);
    this.keep(id, entry, this.edit(entry.local.text, entry.remote?.revision ?? null));
    this.schedule(id, entry);
  }

  stage(id: string, revision: number, dismissSuggestionId?: string) {
    const entry = this.entry(id);
    const current = entry.local;
    if (reviewReason(entry)) throw new LocalizedError(msg('use_chat_draft.review_this_recovered_draft_before_sending_it'));
    clearTimeout(entry.timer);
    const submission = current.submission ?? {
      requestId: newId(), revision, text: trimBoundaryNewlines(current.text), draft: current.sync?.reference, dismissSuggestionId,
    };
    this.keep(id, entry, { ...current, submission });
    return { editId: current.editId, submission };
  }

  acknowledge(id: string, sent: ReturnType<ChatDrafts['stage']>, remote?: ComposerDraft) {
    const entry = this.entry(id);
    if (entry.local.editId === sent.editId && entry.local.submission?.requestId === sent.submission.requestId) {
      this.keep(id, entry, emptyDraft(), true);
    }
    if (remote) this.observe(id, entry, remote);
    else void this.refresh(id);
  }

  reject(id: string, sent: ReturnType<ChatDrafts['stage']>) {
    const entry = this.entry(id);
    if (entry.local.editId === sent.editId && entry.local.submission?.requestId === sent.submission.requestId) {
      this.keep(id, entry, { ...entry.local, submission: null }, true);
      this.schedule(id, entry);
    }
  }

  private observe(id: string, entry: Entry, snapshot: ComposerDraft) {
    // A GET/PUT or Send response can arrive after a newer notification/read.
    const remote = entry.remote && entry.remote.revision > snapshot.revision ? entry.remote : snapshot;
    entry.remote = remote;
    entry.syncError = false;
    const local = entry.local;
    if (differentDataset(local) || local.submission) { this.render(); return; }

    const sync = local.epoch === datasetEpoch() ? local.sync : undefined;
    if (!sync && local.text && remote.revision === 0) {
      // Upgrade a browser-only draft if this branch has no shared draft history.
      this.keep(id, entry, this.edit(local.text, remote.revision), true);
    } else if (sync?.pending && !sameComposerEdit(remote.edit, sync.reference.edit)) {
      const { baseRevision } = sync.reference;
      if (baseRevision === null) {
        this.keep(id, entry, { ...local, sync: { ...sync, reference: { ...sync.reference, baseRevision: remote.revision } } }, true);
      } else if (baseRevision >= remote.sentRevision || reviewReason(entry)) {
        this.render();
      } else {
        this.adopt(id, entry, remote);
      }
    } else {
      this.adopt(id, entry, remote);
    }
  }

  private adopt(id: string, entry: Entry, remote: ComposerDraft) {
    const { local } = entry;
    const sync = remote.edit ? { pending: false, reference: { baseRevision: remote.revision, edit: remote.edit } } : undefined;
    this.keep(id, entry, { ...local, epoch: datasetEpoch(), text: remote.text, sync, editedAfterUnconfirmedSend: undefined }, true);
  }

  refresh = async (id: string, revision?: number) => {
    if (!this.active) return;
    const entry = this.entry(id);
    if (revision !== undefined && (entry.remote?.revision ?? -1) >= revision) return;
    entry.refreshNeeded = true;
    if (entry.reading) return;
    entry.reading = true;
    try {
      while (entry.refreshNeeded && this.active) {
        entry.refreshNeeded = false;
        const remote = composerDraftSchema.parse(await api(path(id), 'GET', undefined, AbortSignal.timeout(10_000)));
        if (this.active) this.observe(id, entry, remote);
      }
      this.schedule(id, entry);
    } catch (error) { this.failed(entry, error); }
    finally {
      entry.reading = false;
      // A reconnect requested during the failed read still needs its own fresh response.
      if (entry.refreshNeeded) void this.refresh(id);
    }
  };

  private schedule(id: string, entry: Entry) {
    clearTimeout(entry.timer);
    if (this.active && entry.local.sync?.pending && !entry.local.submission && !reviewReason(entry)) {
      entry.timer = setTimeout(() => void this.flush(id), 500);
    }
  }

  async flush(id: string) {
    if (!this.active) return;
    const entry = this.entry(id);
    clearTimeout(entry.timer);
    const local = entry.local;
    if (!local.sync?.pending || local.submission || reviewReason(entry)) return;
    if (entry.writing) { entry.flushNeeded = true; return; }
    if (!entry.remote) { void this.refresh(id); return; }
    const input = composerDraftSaveSchema.safeParse({ ...local.sync.reference, text: local.text });
    if (!input.success) {
      entry.syncError = true;
      this.render();
      return;
    }
    entry.flushNeeded = false;
    entry.writing = true;
    try {
      const remote = composerDraftSchema.parse(await api(path(id), 'PUT', input.data, AbortSignal.timeout(10_000)));
      if (this.active) this.observe(id, entry, remote);
    } catch (error) { this.failed(entry, error); }
    finally {
      entry.writing = false;
      if (entry.flushNeeded || entry.local.editId !== local.editId) this.schedule(id, entry);
    }
  }

  private failed(entry: Entry, error: unknown) {
    if (!this.active || (error instanceof ApiError && (error.status === 401 || error.status === 404))) return;
    entry.syncError = true;
    this.render();
  }
}

export function useChatDraft(id: string | null, activeId: string | null, enabled: boolean) {
  const [, render] = useState(0);
  const [drafts] = useState(() => new ChatDrafts(() => render(value => value + 1)));
  useEffect(() => {
    drafts.enable(enabled);
    return () => drafts.enable(false);
  }, [drafts, enabled]);
  useEffect(() => {
    if (!enabled || activeId === null) return;
    const refresh = () => void drafts.refresh(activeId);
    const visibility = () => {
      if (document.visibilityState === 'hidden') void drafts.flush(activeId);
      else refresh();
    };
    refresh();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', refresh);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', refresh);
      void drafts.flush(activeId);
    };
  }, [drafts, activeId, enabled]);

  const current = id === null ? null : drafts.entry(id);
  return {
    savedRevision: current?.remote && !current.local.sync?.pending && current.remote.text === current.local.text ? current.remote.revision : null,
    replace: drafts.replace.bind(drafts),
    reviewReason: current ? reviewReason(current) : null,
    unconfirmed: Boolean(current?.local.submission),
    ready: Boolean(current?.remote || current?.local.submission),
    text: current?.local.text ?? '', storageError: current?.storageError ?? false, syncError: current?.syncError ?? false,
    change: (text: string) => { if (id !== null) drafts.change(id, text); },
    review: () => { if (id !== null) drafts.review(id); },
    retry: () => { if (id !== null) void drafts.refresh(id); },
    refresh: drafts.refresh,
    stage: drafts.stage.bind(drafts), acknowledge: drafts.acknowledge.bind(drafts), reject: drafts.reject.bind(drafts),
  };
}
