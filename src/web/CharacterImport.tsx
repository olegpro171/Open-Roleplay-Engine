import { LibraryImport } from './LibraryImport';
import { LocalizedError, useTextState, errorText, t, message as msg, useLocale } from './localization';
import { newId } from './uuid';
import { CroppedPicture, fileBase64, PictureSquare } from './Pictures';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LibrarySnapshot } from '../shared/library';
import type { CharacterImportResult, CharacterImportReview, TagPolicy } from '../shared/tags';
import { ApiError, api } from './api';
import { LoreDiagnostics } from './LorebookEditor';
import { TagImportOptions } from './Tags';

type Pending = { base64: string; review: CharacterImportReview; requestId: string; policy: TagPolicy; uncertain: boolean };
export function CharacterImport({ revision, busy, run, imported, leadingAction, hidden }: { leadingAction?: ReactNode; hidden?: boolean; revision: number; busy: boolean; run: (action: () => Promise<unknown>) => Promise<boolean>; imported: (result: CharacterImportResult, missing: boolean) => void }) {
  useLocale();
  const [pending, setPending] = useState<Pending | null>(null), [working, setWorking] = useState(false), [error, setError] = useTextState('');
  const attempt = useRef(0), submitting = useRef(false), analysisAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { attempt.current++; analysisAbort.current?.abort(); }, []);
  async function analyze(base64: string, requestId: string = newId()) {
    const current = ++attempt.current; setWorking(true); setError('');
    analysisAbort.current?.abort(); const controller = new AbortController(); analysisAbort.current = controller;
    try {
      const review = await api<CharacterImportReview>('/library/characters/preview', 'POST', { base64 }, controller.signal);
      if (current === attempt.current) setPending({ base64, review, requestId, policy: 'all', uncertain: false });
    } catch (error) { if (current === attempt.current) setError(errorText(error, msg("character_import.could_not_analyze_this_card"))); }
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
        const result = await api<CharacterImportResult>('/library/import', 'POST', { kind: 'characters', revision: captured.review.revision, requestId: captured.requestId, tagPolicy: captured.policy, pictureMode: 'retain', base64: captured.base64 });
        acknowledged = true;
        const snapshot = await api<LibrarySnapshot>('/library');
        if (current !== attempt.current) return;
        setPending(null); imported(result, result.ids.some(id => !snapshot.characters.some(character => character.id === id)));
      } catch (error) {
        if (current === attempt.current) {
          const definite = !acknowledged && error instanceof ApiError && error.status >= 400 && error.status < 500;
          setPending({ ...captured, uncertain: !definite });
          setError(definite ? errorText(error) : msg("character_import.the_acknowledgement_is_uncertain_the_import_may"));
        }
        throw error;
      }
    });
    submitting.current = false;
    if (current === attempt.current) setWorking(false);
  }
  return <section className="character-import" aria-label={t("character_import.character_import")} hidden={hidden}>
    <div className="actions library-toolbar" role="group" aria-label={t("character_import.library_actions")}>{leadingAction}
    <LibraryImport label={t("character_import.import_character")} accept=".json,.png" disabled={busy || working || Boolean(pending)} onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
      const current = ++attempt.current; setWorking(true); setError('');
      try {
        if (file.size > (file.name.toLowerCase().endsWith('.png') ? 10_000_000 : 2_000_000)) throw new LocalizedError(msg("character_import.png_cards_are_limited_to_10_mb"));
        const base64 = await fileBase64(file);
        if (current !== attempt.current) return;
        await analyze(base64);
      } catch (error) { if (current === attempt.current) { setError(errorText(error, msg("character_import.could_not_read_the_card"))); setWorking(false); } }
    }} /></div>
    {working && <p role="status">{pending ? t("character_import.saving_or_reviewing_this_import") : t("character_import.analyzing_this_card")}</p>}
    {pending && <div className="character-import-review"><h2>{t("character_import.review", { name: pending.review.name })}</h2>
      {pending.review.book && <p>{t("character_import.embedded_lorebook_entries_an_independent_linked_book", { name: pending.review.book.name, entries: pending.review.book.entries })}</p>}
      <div className="import-picture">
        <div className="picture-editor-square">{pending.review.picture?.status === 'ready' ? <CroppedPicture image={pending.review.picture.image} /> : <PictureSquare />}</div>
        <p className="import-description small muted" aria-label={t("character_import.character_description_preview")}>{pending.review.description}</p>
      </div>
      {pending.review.picture?.status === 'error' && <p role="alert">{t("character_import.cancel_and_select_a_card_with_valid", { message: pending.review.picture.message })}</p>}
      <LoreDiagnostics diagnostics={pending.review.diagnostics} />
      <TagImportOptions review={pending.review.tags} policy={pending.policy} change={policy => setPending({ ...pending, policy, requestId: newId() })} disabled={working || pending.uncertain} />
      {pending.review.revision !== revision && !pending.uncertain && <p role="status">{t("character_import.the_library_changed_cancel_and_select_the")}</p>}
      {pending.uncertain && <p className="small">{t("character_import.a_command_has_been_sent_closing_this")}</p>}
      <div className="actions"><button type="button" disabled={busy || working || (!pending.uncertain && pending.review.revision !== revision) || Boolean(pending.review.tags.modes[pending.policy].blocked) || pending.review.picture?.status === 'error'} onClick={() => void commit()}>{pending.uncertain ? t("character_import.retry_reviewed_character_import") : t("character_import.import")}</button>
        {!pending.uncertain && <button type="button" className="quiet" disabled={working || busy} onClick={() => { attempt.current++; analysisAbort.current?.abort(); setPending(null); setError(''); }}>{t("character_import.cancel")}</button>}
      </div>
    </div>}{error && <p role="alert">{error}</p>}
  </section>;
}
