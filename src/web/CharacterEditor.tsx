import { useTextState, errorText, t, message as msg, useLocale } from './localization';
import { cardInstructionLabel, stateLabel } from './localization-labels';
import { SpeechColorSelector } from './SpeechColorSelector';
import { newId } from './uuid';
import { Icon } from './Icon';
import { cardInstructionFields, cardInstructionLabels, readCardInstruction, readCharacterDepthPrompt } from '../shared/card-instructions';
import { useConfirmation } from './Confirmation';
import type { CharacterSaveCommand } from '../shared/library';
import { PictureEditor, PictureSquare, pictureMutation, savedPictureDraft } from './Pictures';
import { useEffect, useId, useRef, useState } from 'react';
import { EditorActions } from './EditorActions';
import { EditorTextarea } from './EditorTextarea';
import { readCharacterAlternateGreetings, characterLabel, maxAlternateGreetings, type LibraryCharacter, type LibrarySnapshot } from '../shared/library';
import type { TagPolicy, TagReview } from '../shared/tags';
import { ApiError, api } from './api';
import { Dropdown, NumberInput } from './Controls';
import { TagChooser, TagImportOptions, TagManager, type TagCommit } from './Tags';

type Initial = { id?: string; revision: number; data: LibraryCharacter };
function editableCharacter(data: LibraryCharacter): LibraryCharacter {
  const greetings = readCharacterAlternateGreetings(data);
  const editable = greetings.success ? { ...data, alternate_greetings: greetings.data } : { ...data };
  for (const field of cardInstructionFields) {
    const value = readCardInstruction(data, field);
    if (value.success) editable[field] = value.data;
  }
  const note = readCharacterDepthPrompt(data);
  if (note.success) editable.depth_prompt = note.data;
  return editable;
}
export function CharacterEditor({ initial, library, busy, run, close, openBook, extracted, saved }: { initial: Initial; library: LibrarySnapshot; busy: boolean; run: (action: () => Promise<unknown>) => Promise<boolean>; close: () => void; openBook: (id: string) => void; extracted: (id: string) => void; saved: () => void }) {
  useLocale();
  const formId = useId();
  const confirmAction = useConfirmation();
  const [baselineData, setBaselineData] = useState(() => editableCharacter(initial.data));
  const [baselinePicture, setBaselinePicture] = useState(() => library.characterPictures.find(picture => picture.characterId === initial.id) ?? null);
  const [picture, setPicture] = useState(() => savedPictureDraft(baselinePicture));
  const [processing, setProcessing] = useState(false), [uncertain, setUncertain] = useState<CharacterSaveCommand | null>(null);
  const submitting = useRef(false);
  const [data, setData] = useState(() => editableCharacter(initial.data)), [revision, setRevision] = useState(initial.revision);
  const [baseline, setBaseline] = useState(() => library.characterTags.filter(link => link.characterId === initial.id).map(link => link.tagId));
  const [tagIds, setTagIds] = useState(baseline), [manager, setManager] = useState(false);
  const [embedded, setEmbedded] = useState<{ revision: number; tags: TagReview } | null>(null), [policy, setPolicy] = useState<TagPolicy>('none');
  const [error, setError] = useTextState(''), [pending, setPending] = useState(false);
  const originalRevision = useRef(library.characters.find(character => character.id === initial.id)?.revision);
  const alive = useRef(true), extractionId = useRef(newId());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const stale = revision !== library.revision;
  const greetings = readCharacterAlternateGreetings(data);
  const alternatives = greetings.success ? greetings.data : [];
  const characterChanged = (['name', 'titleComment', 'speechColor', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'lorebookId', 'system_prompt', 'post_history_instructions'] as const).some(field => data[field] !== baselineData[field])
    || JSON.stringify(data.alternate_greetings) !== JSON.stringify(baselineData.alternate_greetings)
    || JSON.stringify(data.depth_prompt) !== JSON.stringify(baselineData.depth_prompt);
  const pictureChanged = pictureMutation(picture, baselinePicture) !== undefined;
  function safeClose() { alive.current = false; close(); }
  const committed: TagCommit = (before, after, snapshot, deletedId) => {
    if (!alive.current || before !== revision || snapshot.revision !== after) return;
    const character = snapshot.characters.find(character => character.id === initial.id);
    const links = snapshot.characterTags.filter(link => link.characterId === initial.id).map(link => link.tagId);
    const expected = baseline.filter(id => id !== deletedId);
    // Advance only our own checked organizational mutation, with the editor's
    // actual character and assignment dependencies still unchanged.
    if (initial.id && (character?.revision !== originalRevision.current || (character?.titleComment ?? '') !== (baselineData.titleComment ?? '') || character?.speechColor !== baselineData.speechColor || (snapshot.characterPictures.find(picture => picture.characterId === initial.id)?.key ?? null) !== (baselinePicture?.key ?? null) || expected.length !== links.length || expected.some(id => !links.includes(id)))) return;
    setRevision(after); setBaseline(links); setEmbedded(null);
    if (deletedId) setTagIds(ids => ids.filter(id => id !== deletedId));
  };
  async function applyEmbedded() {
    if (!initial.id || !embedded || pending) return;
    setPending(true); setError('');
    await run(async () => {
      try {
        const result = await api<{ revision: number }>(`/library/characters/${initial.id}/tags/apply`, 'POST', { revision: embedded.revision, tagPolicy: policy });
        const snapshot = await api<LibrarySnapshot>('/library');
        if (!alive.current || embedded.revision !== revision || snapshot.revision !== result.revision || snapshot.characters.find(card => card.id === initial.id)?.revision !== originalRevision.current || (snapshot.characters.find(card => card.id === initial.id)?.titleComment ?? '') !== (baselineData.titleComment ?? '') || snapshot.characters.find(card => card.id === initial.id)?.speechColor !== baselineData.speechColor || (snapshot.characterPictures.find(picture => picture.characterId === initial.id)?.key ?? null) !== (baselinePicture?.key ?? null)) return;
        const links = snapshot.characterTags.filter(link => link.characterId === initial.id).map(link => link.tagId);
        setTagIds(ids => [...new Set([...ids, ...links.filter(id => !baseline.includes(id))])]);
        setBaseline(links); setRevision(result.revision); setEmbedded(null);
      } catch (error) { setError(errorText(error, msg("character_editor.could_not_apply_embedded_tags"))); throw error; }
    });
    setPending(false);
  }
  async function save(frozen?: CharacterSaveCommand) {
    if (submitting.current || processing || (uncertain && !frozen)) return;
    submitting.current = true; setPending(true); setError('');
    const command: CharacterSaveCommand = frozen ?? { kind: 'characters', requestId: newId(), revision, data: structuredClone(data), tagIds: [...tagIds], expectedPicture: baselinePicture?.key ?? null, picture: pictureMutation(picture, baselinePicture) };
    setUncertain(command);
    const ok = await run(async () => {
      try { await api(initial.id ? `/library/${initial.id}` : '/library', initial.id ? 'PUT' : 'POST', command); }
      catch (error) {
        if (alive.current) {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) { setUncertain(null); setError(errorText(error)); }
          else setError(msg("character_editor.the_acknowledgement_is_uncertain_retry_the_same"));
        }
        throw error;
      }
    });
    submitting.current = false;
    if (!alive.current) return;
    setPending(false);
    if (ok) { setUncertain(null); saved(); safeClose(); }
  }
  function reconcile() {
    const current = library.characters.find(card => card.id === initial.id);
    if (initial.id && !current) return;
    if (current) {
      const { id: _id, revision: savedRevision, ...fields } = current;
      setData(editableCharacter(fields)); setBaselineData(editableCharacter(fields)); originalRevision.current = savedRevision;
      const links = library.characterTags.filter(link => link.characterId === initial.id).map(link => link.tagId);
      setBaseline(links); setTagIds(links);
    }
    const savedPicture = library.characterPictures.find(item => item.characterId === initial.id) ?? null;
    if (!pictureChanged) setPicture(savedPictureDraft(savedPicture));
    setBaselinePicture(savedPicture); setRevision(library.revision); setEmbedded(null); setError('');
  }
  const source = initial.data.source ?? {};
  const nested = source.data;
  const embeddedBook = source.spec === 'chara_card_v2' || source.spec === 'chara_card_v3'
    ? typeof nested === 'object' && nested !== null && 'character_book' in nested && nested.character_book != null
    : source.character_book != null;
  return <>
    <form id={formId} onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy || pending || stale || Boolean(uncertain)}><legend>{t("character_editor.character", { value: initial.id ? t("libraries.edit_2") : t("libraries.create") })}</legend><div className="form-grid">
      <label>{t("character_editor.name")}<input required maxLength={100} value={data.name} onChange={event => setData({ ...data, name: event.target.value })} /></label>
      <label>{t("character_editor.title_comment")}<input aria-label={t("character_editor.title_comment")} maxLength={200} value={data.titleComment ?? ''} onChange={event => setData({ ...data, titleComment: event.target.value })} /><small>{t("character_editor.an_optional_label_useful_for_distinguishing_between")}</small></label>
      <SpeechColorSelector value={data.speechColor} change={speechColor => setData({ ...data, speechColor })} />
      <PictureEditor value={picture} change={setPicture} original={baselinePicture} disabled={busy || pending || stale || Boolean(uncertain)} processing={setProcessing} />
      {([['description', t("character_editor.character_description")], ['personality', t("character_editor.personality")], ['scenario', t("character_editor.scenario")], ['first_mes', t("character_editor.greeting")], ['mes_example', t("character_editor.example_dialogue")]] as const).map(([field, label]) => <label key={field} className="full">{label}<EditorTextarea aria-label={label} maxLength={100_000} value={data[field]} onChange={event => setData({ ...data, [field]: event.target.value })} /></label>)}
      <CardInstructions value={data} change={setData} />
      <div className="full" role="group" aria-label={t("character_editor.alternate_greetings")}>
        <h3>{t("character_editor.alternate_greetings")}</h3>
        {!greetings.success && <p role="alert">{t("character_editor.the_preserved_alternate_greetings_are_invalid_they")}</p>}
        {alternatives.map((greeting, index) => <div className="alternate-greeting" key={index}>
          <label>{t("character_editor.alternate_greeting", { value: index + 1 })}<EditorTextarea aria-label={t("character_editor.alternate_greeting", { value: index + 1 })} maxLength={100_000} value={greeting} onChange={event => setData({ ...data, alternate_greetings: alternatives.map((text, position) => position === index ? event.target.value : text) })} /></label>
          <button type="button" className="quiet" aria-label={t("character_editor.remove_alternate_greeting", { value: index + 1 })} onClick={() => setData({ ...data, alternate_greetings: alternatives.filter((_, position) => position !== index) })}>{t("character_editor.remove_greeting")}</button>
        </div>)}
        {greetings.success ? <button type="button" className="secondary add-alternate-greeting" disabled={alternatives.length >= maxAlternateGreetings} onClick={() => setData({ ...data, alternate_greetings: [...alternatives, ''] })}>{t("character_editor.add_alternate_greeting")}</button>
          : <button type="button" className="secondary" onClick={() => setData({ ...data, alternate_greetings: [] })}>{t("character_editor.clear_invalid_alternate_greetings")}</button>}
      </div>
      <label className="full">{t("character_editor.default_lorebook")}<Dropdown aria-label={t("character_editor.default_lorebook")} value={data.lorebookId ?? ''} options={[{ value: '', label: t("character_editor.none_selected") }, ...library.lorebooks.map(book => ({ value: book.id, label: book.name }))]} onChange={id => setData({ ...data, lorebookId: id || null })} /></label>
      {data.lorebookId && <button type="button" className="secondary" onClick={() => { const bookId = data.lorebookId; if (!bookId) return; if (!characterChanged && !pictureChanged && tagIds.join() === baseline.join()) openBook(bookId); else confirmAction({ title: t("character_editor.discard_character_edits"), message: t("character_editor.open_the_book_and_discard_unsaved_character"), actionLabel: t("character_editor.discard_edits"), onConfirm: () => openBook(bookId) }); }}>{t("character_editor.open_book")}</button>}
      {initial.id && !data.lorebookId && embeddedBook && <div className="full"><button type="button" className="secondary" disabled={characterChanged || pictureChanged || tagIds.join() !== baseline.join()} onClick={async () => { let bookId = ''; if (await run(async () => { bookId = (await api<{ bookId: string }>(`/library/characters/${initial.id}/extract`, 'POST', { revision, requestId: extractionId.current })).bookId; })) extracted(bookId); }}>{t("character_editor.extract_embedded_lorebook")}</button><p className="small muted">{t("character_editor.save_character_edits_first_extraction_creates_and")}</p></div>}
      <div className="full"><TagChooser label={t("character_editor.assign_tags")} tags={library.tags} selected={tagIds} change={setTagIds} /><button type="button" className="secondary" onClick={() => setManager(true)}>{t("character_editor.manage_tags")}</button>
        {initial.id && <button type="button" className="quiet" onClick={async () => { setPending(true); await run(async () => { const preview = await api<{ revision: number; tags: TagReview }>(`/library/characters/${initial.id}/tags/preview`); if (alive.current) { setEmbedded(preview); setPolicy('none'); } }); setPending(false); }}>{t("character_editor.review_embedded_tags")}</button>}
      </div>
    </div></fieldset>{error && <p role="alert">{error}</p>}{uncertain && <p role="status">{t("character_editor.acknowledgement_uncertain_the_save_may_have_reached")}</p>}{stale && !uncertain && <CharacterReconciliation library={library} characterId={initial.id} disabled={busy || pending} reconcile={reconcile} />}<EditorActions><button type="submit" form={formId} disabled={busy || pending || processing || stale || Boolean(uncertain)}>{t("character_editor.save_character")}</button>{uncertain && <button type="button" disabled={busy || pending} onClick={() => void save(uncertain)}>{t("character_editor.retry_same_save")}</button>}<button type="button" className="quiet" disabled={pending} onClick={safeClose} title={t("character_editor.close_editor")}><Icon name="Close" /><span className="sr-only">{t("character_editor.close_editor")}</span></button></EditorActions></form>
    {manager && <TagManager library={library} busy={busy || pending} run={run} committed={committed} close={() => setManager(false)} />}
    {embedded && <section className="character-import-review"><h2>{t("character_editor.review_embedded_tags")}</h2><p className="small">{t("character_editor.this_saves_only_local_tags_preserving_your")}</p><TagImportOptions review={embedded.tags} policy={policy} change={setPolicy} disabled={busy || pending} /><button type="button" disabled={busy || pending || stale || embedded.revision !== revision || Boolean(embedded.tags.modes[policy].blocked)} onClick={() => void applyEmbedded()}>{t("character_editor.apply_reviewed_tags")}</button><button type="button" className="quiet" onClick={() => setEmbedded(null)}>{t("character_editor.cancel_embedded_tags")}</button></section>}
  </>;
}

function CharacterReconciliation({ library, characterId, disabled, reconcile }: { library: LibrarySnapshot; characterId?: string; disabled: boolean; reconcile: () => void }) {
  useLocale();
  const character = library.characters.find(card => card.id === characterId);
  const picture = library.characterPictures.find(picture => picture.characterId === characterId);
  const selectedTags = new Set(library.characterTags.filter(link => link.characterId === characterId).map(link => link.tagId));
  const greetings = character ? readCharacterAlternateGreetings(character) : null;
  const greetingTexts = greetings?.success ? greetings.data : null;
  return <section className="character-reconcile">
    <p role="status">{t("character_editor.the_library_changed_your_unsaved_edits_and")}</p>
    {characterId && <>
      <p className="small">{t("character_editor.current_saved_character_tags_review_current_text", { value: character ? characterLabel(character) : t("interface.deleted"), size: selectedTags.size })}</p>
      <PictureSquare url={picture?.thumbnailUrl} />
      {character && <details><summary>{t("character_editor.current_saved_text_and_tags")}</summary>
        {(['name', 'titleComment', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'] as const).map((field, index) => <div key={field}><strong>{[t("character_editor.name"), t("character_editor.title_comment"), t("character_editor.description"), t("character_editor.personality"), t("character_editor.scenario"), t("character_editor.greeting"), t("character_editor.example_dialogue")][index]}</strong><p className="prose small">{character[field] || t("character_editor.empty")}</p></div>)}
        <strong>{t("character_editor.speech_color")}</strong><p>{character.speechColor ?? t("character_editor.not_set")}</p>
        <CardInstructions value={character} />
        <strong>{t("character_editor.alternate_greetings")}</strong>
        {greetingTexts === null && <p>{t("character_editor.invalid_preserved_alternate_greetings_raw_metadata_is")}</p>}
        {greetingTexts?.length === 0 && <p>{t("character_editor.none")}</p>}
        {greetingTexts?.map((text, index) => <div key={index}><strong>{t("character_editor.alternate_greeting", { value: index + 1 })}</strong><p className="prose small">{text || t("character_editor.empty")}</p></div>)}
        <strong>{t("character_editor.default_lorebook")}</strong><p>{library.lorebooks.find(book => book.id === character.lorebookId)?.name ?? t("character_editor.none")}</p>
        <strong>{t("character_editor.tags")}</strong><p>{library.tags.filter(tag => selectedTags.has(tag.id)).map(tag => tag.name).join(', ') || t("character_editor.none")}</p>
      </details>}
    </>}
    <button type="button" className="secondary" disabled={disabled || Boolean(characterId && !character)} onClick={reconcile}>{t("character_editor.use_current_text_and_tags_keep_my")}</button>
    <p className="small muted">{t("character_editor.this_replaces_local_text_tag_edits_with")}</p>
  </section>;
}

function CardInstructions({ value, change }: { value: LibraryCharacter; change?: (value: LibraryCharacter) => void }) {
  useLocale();
  const [open, setOpen] = useState(false);
  const note = readCharacterDepthPrompt(value);
  function instructionField(field: typeof cardInstructionFields[number]) {
    const instruction = readCardInstruction(value, field);
    const label = cardInstructionLabel(field);
    if (!instruction.success) return <div className="full" key={field}>
      <p role="alert">{t("character_editor.is_invalid_the_preserved_value_will_remain", { label: label })}</p>
      {change && <button type="button" className="secondary" onClick={() => change({ ...value, [field]: '' })}>{t("character_editor.clear_invalid", { value: label.toLowerCase() })}</button>}
    </div>;
    if (!change) return <p className="prose small full" key={field}>{label}: {instruction.data || t("character_editor.empty")}</p>;
    return <label className="full" key={field}>{label}
      <EditorTextarea aria-label={label} maxLength={100_000} value={instruction.data} onChange={event => change({ ...value, [field]: event.target.value })} />
    </label>;
  }
  return <details className="full card-instructions" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t("character_editor.card_instructions")}</summary>
    {open && <div className="form-grid">
      <p className="small muted full">{t("character_editor.the_prompt_preset_controls_whether_these_instructions")}</p>
      {cardInstructionFields.map(instructionField)}
      {!note.success ? <div className="full">
        <p role="alert">{t("character_editor.the_character_depth_note_has_invalid_settings")}</p>
        {change && <button type="button" className="secondary" onClick={() => change({ ...value, depth_prompt: { prompt: '', depth: 2, role: 'system' } })}>{t("character_editor.clear_invalid_character_depth_note")}</button>}
      </div> : change ? <>
        <label className="full">{t("character_editor.character_depth_note")}<EditorTextarea aria-label={t("character_editor.character_depth_note_2")} maxLength={100_000} value={note.data.prompt} onChange={event => change({ ...value, depth_prompt: { ...note.data, prompt: event.target.value } })} />
        </label>
        <label>{t("character_editor.character_note_depth")}<NumberInput aria-label={t("character_editor.character_note_depth_2")} required min={0} max={1000} value={note.data.depth} onChange={depth => change({ ...value, depth_prompt: { ...note.data, depth } })} />
        </label>
        <label>{t("character_editor.character_note_role")}<Dropdown aria-label={t("character_editor.character_note_role_2")} value={note.data.role} onChange={role => {
            if (role === 'system' || role === 'user' || role === 'assistant') change({ ...value, depth_prompt: { ...note.data, role } });
          }} options={['system', 'user', 'assistant'].map(role => ({ value: role, label: stateLabel(role === 'system' || role === 'user' ? role : 'assistant') }))} />
        </label>
        <p className="small muted full">{t("character_editor.depth_0_follows_the_newest_history_message")}</p>
      </> : <p className="prose small full">{t("character_editor.character_depth_note_depth", { role: note.data.role, depth: note.data.depth, value: note.data.prompt || t("character_editor.empty") })}</p>}
    </div>}
  </details>;
}
