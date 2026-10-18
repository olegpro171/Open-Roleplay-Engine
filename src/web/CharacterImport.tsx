import { CroppedPicture, fileBase64, PictureSquare } from './Pictures';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LibrarySnapshot } from '../shared/library';
import type { CharacterImportResult, CharacterImportReview, TagPolicy } from '../shared/tags';
import { ApiError, api } from './api';
import { LoreDiagnostics } from './LorebookEditor';
import { TagImportOptions } from './Tags';

type Pending = { base64: string; review: CharacterImportReview; requestId: string; policy: TagPolicy; pictureMode: 'retain' | 'none'; uncertain: boolean };
export function CharacterImport({ revision, busy, run, imported, leadingAction, trailingAction, hidden }: { leadingAction?: ReactNode; trailingAction?: ReactNode; hidden?: boolean; revision: number; busy: boolean; run: (action: () => Promise<unknown>) => Promise<boolean>; imported: (result: CharacterImportResult, missing: boolean) => void }) {
  const [pending, setPending] = useState<Pending | null>(null), [working, setWorking] = useState(false), [error, setError] = useState('');
  const attempt = useRef(0), submitting = useRef(false), analysisAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { attempt.current++; analysisAbort.current?.abort(); }, []);
  async function analyze(base64: string, requestId: string = crypto.randomUUID()) {
    const current = ++attempt.current; setWorking(true); setError('');
    analysisAbort.current?.abort(); const controller = new AbortController(); analysisAbort.current = controller;
    try {
      const review = await api<CharacterImportReview>('/library/characters/preview', 'POST', { base64 }, controller.signal);
      if (current === attempt.current) setPending({ base64, review, requestId, policy: 'none', pictureMode: 'retain', uncertain: false });
    } catch (error) { if (current === attempt.current) setError(error instanceof Error ? error.message : 'Could not analyze this card.'); }
    finally { if (current === attempt.current) setWorking(false); }
  }
  async function commit() {
    if (!pending || submitting.current) return;
    const captured = pending, current = attempt.current;
    submitting.current = true; setWorking(true); setError('');
    setPending({ ...captured, uncertain: true });
    await run(async () => {
      let acknowledged = false;
      try {
        const result = await api<CharacterImportResult>('/library/import', 'POST', { kind: 'characters', revision: captured.review.revision, requestId: captured.requestId, tagPolicy: captured.policy, pictureMode: captured.pictureMode, base64: captured.base64 });
        acknowledged = true;
        const snapshot = await api<LibrarySnapshot>('/library');
        if (current !== attempt.current) return;
        setPending(null); imported(result, result.ids.some(id => !snapshot.characters.some(character => character.id === id)));
      } catch (error) {
        if (current === attempt.current) {
          const definite = !acknowledged && error instanceof ApiError && error.status >= 400 && error.status < 500;
          setPending({ ...captured, uncertain: !definite });
          setError(definite ? error.message : 'The acknowledgement is uncertain. The import may already be saved. Retry uses the same card, policy and command identity and cannot create a second copy.');
        }
        throw error;
      }
    });
    submitting.current = false;
    if (current === attempt.current) setWorking(false);
  }
  return <section className="character-import" aria-label="Character import" hidden={hidden}>
    <div className="actions library-toolbar character-toolbar" role="group" aria-label="Library actions">{leadingAction}
    <label className="file-button">Import character<input type="file" accept=".json,.png" disabled={busy || working || Boolean(pending)} onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      const current = ++attempt.current; setWorking(true); setError('');
      try {
        if (file.size > (file.name.toLowerCase().endsWith('.png') ? 10_000_000 : 2_000_000)) throw new Error('PNG cards are limited to 10 MB; JSON cards to 2 MB.');
        const base64 = await fileBase64(file);
        if (current !== attempt.current) return;
        await analyze(base64);
      } catch (error) { if (current === attempt.current) { setError(error instanceof Error ? error.message : 'Could not read the card.'); setWorking(false); } }
    }} /></label>{trailingAction}</div>
    {working && <p role="status">{pending ? 'Saving or reviewing this import…' : 'Analyzing this card…'}</p>}
    {pending && <div className="character-import-review"><h2>Review {pending.review.name}</h2><p>{pending.review.book ? `Embedded lorebook “${pending.review.book.name}”: ${pending.review.book.entries} entries. An independent linked book will be created.` : 'No embedded lorebook.'}</p>
      <div className="import-picture"><div className="picture-editor-square">{pending.review.picture?.status === 'ready' && pending.pictureMode === 'retain' ? <CroppedPicture image={pending.review.picture.image} /> : <PictureSquare />}</div><div>{pending.review.picture?.status === 'ready' ? <p className="small">Centered square picture ready. Adjust its crop in Edit character after import.</p> : pending.review.picture?.status === 'error' ? <p role="alert">{pending.review.picture.message} Card, book and tag analysis is retained.</p> : <p className="small muted">No picture in this JSON card.</p>}{pending.review.picture?.status !== 'none' && <label className="checkbox"><input type="checkbox" disabled={working || pending.uncertain} checked={pending.pictureMode === 'none'} onChange={event => setPending({ ...pending, pictureMode: event.target.checked ? 'none' : 'retain', requestId: crypto.randomUUID() })} />Import without picture</label>}{pending.pictureMode === 'none' && <p className="small">No picture will be saved.</p>}</div></div>
      <LoreDiagnostics diagnostics={pending.review.diagnostics} />
      <TagImportOptions review={pending.review.tags} policy={pending.policy} change={policy => setPending({ ...pending, policy, requestId: crypto.randomUUID() })} disabled={working || pending.uncertain} />
      {pending.review.revision !== revision && !pending.uncertain && <p role="status">The library changed. Refresh and review before importing.</p>}
      {pending.uncertain && <p className="small">A command has been sent. Closing this page does not undo a saved import. Retry here to reconcile its acknowledgement.</p>}
      <div className="actions"><button type="button" disabled={busy || working || (!pending.uncertain && pending.review.revision !== revision) || Boolean(pending.review.tags.modes[pending.policy].blocked) || (pending.review.picture?.status === 'error' && pending.pictureMode !== 'none')} onClick={() => void commit()}>{pending.uncertain ? 'Retry reviewed character import' : 'Import reviewed character'}</button>
        {!pending.uncertain && <><button type="button" className="secondary" disabled={working || busy} onClick={() => void analyze(pending.base64, pending.requestId)}>Refresh character review</button><button type="button" className="quiet" disabled={working || busy} onClick={() => { attempt.current++; analysisAbort.current?.abort(); setPending(null); setError(''); }}>Cancel character import</button></>}
      </div>
    </div>}{error && <p role="alert">{error}</p>}
  </section>;
}
