import { useTextState, errorText, t, message as msg, useLocale } from './localization';
import { cardInstructionLabel, stateLabel } from './localization-labels';
import { SpeechColorSelector } from './SpeechColorSelector';
import type { ChatPreviewAppearance } from './ChatTextPreview';
import { newId } from './uuid';
import { Icon } from './Icon';
import { cardInstructionFields, readCardInstruction, readCharacterDepthPrompt } from '../shared/card-instructions';
import { WarningDetails, WarningMessages } from './WarningDialog';
import type { CharacterSaveCommand } from '../shared/library';
import { PictureEditor, PictureSquare, pictureMutation, savedPictureDraft } from './Pictures';
import { useContext, useEffect, useId, useMemo, useRef, useState, type InvalidEvent, type MouseEventHandler } from 'react';
import { flushSync } from 'react-dom';
import { EditorNameField, revealInvalidField } from './LibraryEditorFields';
import { EditorTabs } from './EditorTabs';
import { EditorActions } from './EditorActions';
import { CopyLibraryDraft, LibraryDraftNotice, useLibraryEditorDraft } from './LibraryDraft';
import type { DraftOf, SetupReturn } from './library-draft';
import { EditorTextarea } from './EditorTextarea';
import { readCharacterAlternateGreetings, characterLabel, maxAlternateGreetings, type LibraryCharacter, type LibrarySnapshot } from '../shared/library';
import type { TagPolicy, TagReview } from '../shared/tags';
import { ApiError, api } from './api';
import { Dropdown, NumberDraftContext, NumberInput, useNumberDraft } from './Controls';
import { TagChooser, TagImportOptions, TagManager, type TagCommit } from './Tags';
import { sortLibraryRecords } from './library-sorting';

const characterTabs = [
  ['profile', 'character_editor.profile'],
  ['dialogue', 'character_editor.dialogue'],
  ['library', 'character_editor.lore_and_tags'],
] as const;
type CharacterTab = (typeof characterTabs)[number][0];

type Initial = { id?: string; revision: number; data: LibraryCharacter; returnTo?: SetupReturn };
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
export function CharacterEditor({ initial, recovered, library, appearance, busy, run, close, openBook, extracted, saved }: { initial: Initial; recovered?: DraftOf<'characters'>; library: LibrarySnapshot; appearance: ChatPreviewAppearance; busy: boolean; run: (action: () => Promise<unknown>) => Promise<boolean>; close: MouseEventHandler<HTMLButtonElement>; openBook: (id: string, returnFocus: HTMLElement) => void; extracted: (id: string) => void; saved: (id: string) => void }) {
  useLocale();
  const formId = useId();
  const [activeTab, setActiveTab] = useState<CharacterTab>('profile');
  const [baselineData, setBaselineData] = useState(() => editableCharacter(initial.data));
  const [baselinePicture, setBaselinePicture] = useState(() => library.characterPictures.find(picture => picture.characterId === initial.id) ?? null);
  const [picture, setPicture] = useState(() => savedPictureDraft(baselinePicture));
  const [processing, setProcessing] = useState(false), [uncertain, setUncertain] = useState<CharacterSaveCommand | null>(null);
  const submitting = useRef(false);
  const [data, setData] = useState(() => recovered?.data ?? baselineData), [revision, setRevision] = useState(initial.revision);
  const [baseline, setBaseline] = useState(() => library.characterTags.filter(link => link.characterId === initial.id).map(link => link.tagId));
  const [tagIds, setTagIds] = useState(recovered?.tagIds ?? baseline), [manager, setManager] = useState(false);
  const [embedded, setEmbedded] = useState<{ revision: number; tags: TagReview } | null>(null), [policy, setPolicy] = useState<TagPolicy>('none');
  const [error, setError] = useTextState(''), [pending, setPending] = useState(false);
  const originalRevision = useRef(library.characters.find(character => character.id === initial.id)?.revision);
  const alive = useRef(true), extractionId = useRef(newId());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const stale = revision !== library.revision;
  const draftControlsDisabled = busy || pending || uncertain !== null;
  const greetings = readCharacterAlternateGreetings(data);
  const alternatives = greetings.success ? greetings.data : [];
  const characterChanged = (['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions'] as const).some(field => data[field] !== baselineData[field])
    || (data.titleComment ?? '') !== (baselineData.titleComment ?? '')
    || (data.speechColor ?? null) !== (baselineData.speechColor ?? null)
    || (data.lorebookId ?? null) !== (baselineData.lorebookId ?? null)
    || JSON.stringify(data.alternate_greetings) !== JSON.stringify(baselineData.alternate_greetings)
    || JSON.stringify(data.depth_prompt) !== JSON.stringify(baselineData.depth_prompt);
  const pictureChanged = pictureMutation(picture, baselinePicture) !== undefined;
  const tagsChanged = tagIds.length !== baseline.length || tagIds.some(id => !baseline.includes(id));
  const numberDraft = useNumberDraft(recovered?.numbers);
  const dirty = characterChanged || pictureChanged || tagsChanged || processing || numberDraft.dirty;
  const draft = useMemo<DraftOf<'characters'>>(() => ({ kind: 'characters', id: initial.id, returnTo: initial.returnTo, revision, data, tagIds, pictureOmitted: pictureChanged || processing, numbers: numberDraft.values }),
    [initial.id, initial.returnTo, revision, data, tagIds, pictureChanged, processing, numberDraft.values]);
  const storageError = useLibraryEditorDraft(draft, dirty);
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
    if (!initial.id || !embedded || busy || pending || stale) return;
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
    if (busy || submitting.current || processing || (!frozen && (stale || uncertain))) return;
    submitting.current = true; setPending(true); setError('');
    const command: CharacterSaveCommand = frozen ?? { kind: 'characters', requestId: newId(), revision, data: structuredClone(data), tagIds: [...tagIds], expectedPicture: baselinePicture?.key ?? null, picture: pictureMutation(picture, baselinePicture) };
    setUncertain(command);
    let id: string | undefined;
    const ok = await run(async () => {
      try { id = (await api<{ id: string }>(initial.id ? `/library/${initial.id}` : '/library', initial.id ? 'PUT' : 'POST', command)).id; }
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
    if (ok && id) { setUncertain(null); saved(id); }
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
    numberDraft.set('characterDepth', undefined);
    setBaselinePicture(savedPicture); setRevision(library.revision); setEmbedded(null); setError('');
  }
  const source = initial.data.source ?? {};
  const nested = source.data;
  const embeddedBook = source.spec === 'chara_card_v2' || source.spec === 'chara_card_v3'
    ? typeof nested === 'object' && nested !== null && 'character_book' in nested && nested.character_book != null
    : source.character_book != null;
  const openingsId = `${formId}-openings`;
  const alternativesId = `${formId}-alternatives`;
  const alternativesHelpId = `${formId}-alternatives-help`;
  async function reviewEmbeddedTags() {
    setPending(true);
    await run(async () => {
      const preview = await api<{ revision: number; tags: TagReview }>(`/library/characters/${initial.id}/tags/preview`);
      if (alive.current) { setEmbedded(preview); setPolicy('none'); }
    });
    if (alive.current) setPending(false);
  }
  async function extractBook() {
    let bookId = '';
    const ok = await run(async () => {
      const result = await api<{ bookId: string }>(`/library/characters/${initial.id}/extract`, 'POST', {
        revision, requestId: extractionId.current,
      });
      bookId = result.bookId;
    });
    if (ok && alive.current) extracted(bookId);
  }
  function panel(tab: CharacterTab) {
    return {
      role: 'tabpanel', id: `${formId}-${tab}-panel`, 'aria-labelledby': `${formId}-${tab}-tab`,
      hidden: activeTab !== tab,
      onInvalid: (event: InvalidEvent<HTMLDivElement>) => revealInvalidField(event, () => setActiveTab(tab)),
    };
  }
  function textField(field: 'description' | 'personality' | 'scenario' | 'mes_example' | 'first_mes', label: string, help: string, placeholder?: string) {
    const helpId = `${formId}-${field}-help`;
    return <label className="full">{label}
      <small id={helpId}>{help}</small>
      <EditorTextarea aria-label={label} aria-describedby={helpId} placeholder={placeholder} maxLength={100_000} value={data[field]}
        onChange={event => setData({ ...data, [field]: event.target.value })} />
    </label>;
  }
  return <NumberDraftContext.Provider value={numberDraft}>
    <form id={formId} onSubmit={event => { event.preventDefault(); void save(); }}>
      <LibraryDraftNotice recovered={recovered} storageError={storageError} />
      <fieldset disabled={draftControlsDisabled} className="tabbed-library-editor character-editor">
        <legend className="sr-only">{t("character_editor.character", { value: initial.id ? t("libraries.edit_2") : t("libraries.create") })}</legend>
        <div className="library-editor-identity">
          <EditorNameField value={data.name} change={name => setData({ ...data, name })}
            help={initial.id ? undefined : t('story_home.character_editor_help')} />
          <label>{t('character_editor.title_comment')}
            <input aria-label={t('character_editor.title_comment')} aria-describedby={`${formId}-title-help`}
              maxLength={200} value={data.titleComment ?? ''} onChange={event => setData({ ...data, titleComment: event.target.value })} />
            <small id={`${formId}-title-help`}>{t('character_editor.an_optional_label_useful_for_distinguishing_between')}</small>
          </label>
        </div>
        <EditorTabs id={formId} label={t('character_editor.sections')} tabs={characterTabs} active={activeTab}
          select={setActiveTab} className="tabs library-editor-tabs" />
        <div {...panel('profile')}>
          <div className="character-appearance">
            <PictureEditor value={picture} change={setPicture} original={baselinePicture} disabled={draftControlsDisabled} processing={setProcessing} />
            <SpeechColorSelector appearance={appearance} value={data.speechColor} change={speechColor => setData({ ...data, speechColor })} disabled={draftControlsDisabled} />
          </div>
          <div className="character-writing">
            {textField('description', t('character_editor.character_description'), t('character_editor.description_help'))}
            {textField('personality', t('character_editor.personality'), t('character_editor.personality_help'))}
            {textField('scenario', t('character_editor.scenario'), t('character_editor.scenario_help'))}
            {textField('mes_example', t('character_editor.example_dialogue'),
              t('character_editor.example_dialogue_help', { start: '<START>' }), '<START>\n{{user}}: \n{{char}}:')}
          </div>
          <CardInstructions value={data} change={setData} />
        </div>
        <div {...panel('dialogue')}>
          <div className="full form-grid opening-messages" role="group" aria-labelledby={openingsId}>
            <h2 className="full" id={openingsId}>{t('character_editor.opening_messages')}</h2>
            {textField('first_mes', t('character_editor.greeting'), t('character_editor.greeting_help'))}
            <div className="full" role="group" aria-labelledby={alternativesId} aria-describedby={alternativesHelpId}>
              <h3 id={alternativesId}>{t('character_editor.alternate_greetings')}</h3>
              <p className="small muted" id={alternativesHelpId}>{t('character_editor.alternate_greetings_help')}</p>
              {!greetings.success && <WarningDetails message={msg("character_editor.the_preserved_alternate_greetings_are_invalid_they")} />}
              {alternatives.map((greeting, index) => {
                const label = t('character_editor.alternate_greeting', { value: index + 1 });
                return <div className="alternate-greeting" key={index}>
                  <label>{label}
                    <EditorTextarea id={`${alternativesId}-${index}`} aria-label={label} maxLength={100_000} value={greeting}
                      onChange={event => setData({ ...data, alternate_greetings: alternatives.map((text, position) => position === index ? event.target.value : text) })} />
                  </label>
                  <button type="button" className="quiet" aria-label={t('character_editor.remove_alternate_greeting', { value: index + 1 })}
                    onClick={() => setData({ ...data, alternate_greetings: alternatives.filter((_, position) => position !== index) })}>
                    {t('character_editor.remove_greeting')}
                  </button>
                </div>;
              })}
              {greetings.success ? <button type="button" className="secondary add-alternate-greeting" disabled={alternatives.length >= maxAlternateGreetings}
                onClick={() => {
                  flushSync(() => setData({ ...data, alternate_greetings: [...alternatives, ''] }));
                  document.getElementById(`${alternativesId}-${alternatives.length}`)?.focus();
                }}>{t('character_editor.add_alternate_greeting')}</button>
                : <button type="button" className="secondary" onClick={() => setData({ ...data, alternate_greetings: [] })}>
                    {t('character_editor.clear_invalid_alternate_greetings')}
                  </button>}
            </div>
          </div>
        </div>
        <div {...panel('library')}>
          <div className="character-lorebook">
            <label>{t('character_editor.default_lorebook')}
              <Dropdown aria-label={t('character_editor.default_lorebook')} value={data.lorebookId ?? ''}
                options={[{ value: '', label: t('character_editor.none_selected') },
                  ...sortLibraryRecords(library.lorebooks, 'lorebooks', library.dates).map(book => ({ value: book.id, label: book.name }))]}
                onChange={id => setData({ ...data, lorebookId: id || null })} />
            </label>
            {data.lorebookId && <button type="button" className="secondary"
              onClick={event => { if (data.lorebookId) openBook(data.lorebookId, event.currentTarget); }}>
              {t('character_editor.open_book')}
            </button>}
            {initial.id && !data.lorebookId && embeddedBook && <div className="full">
              <button type="button" className="secondary" disabled={dirty || stale} onClick={() => void extractBook()}>
                {t('character_editor.extract_embedded_lorebook')}
              </button>
              <p className="small muted">{t('character_editor.save_character_edits_first_extraction_creates_and')}</p>
            </div>}
          </div>
          <div className="character-tags">
            <TagChooser label={t("character_editor.assign_tags")} tags={library.tags} selected={tagIds} change={setTagIds} />
            <div className="actions">
              <button type="button" className="secondary" disabled={stale} onClick={() => setManager(true)}>{t("character_editor.manage_tags")}</button>
              {initial.id && <button type="button" className="quiet" disabled={stale} onClick={() => void reviewEmbeddedTags()}>
                {t('character_editor.review_embedded_tags')}
              </button>}
            </div>
            {embedded && <section className="character-import-review">
              <h2>{t('character_editor.review_embedded_tags')}</h2>
              <p className="small">{t('character_editor.this_saves_only_local_tags_preserving_your')}</p>
              <TagImportOptions review={embedded.tags} policy={policy} change={setPolicy} disabled={busy || pending} />
              <div className="actions">
                <button type="button" disabled={stale || embedded.revision !== revision || Boolean(embedded.tags.modes[policy].blocked)}
                  onClick={() => void applyEmbedded()}>{t('character_editor.apply_reviewed_tags')}</button>
                <button type="button" className="quiet" onClick={() => setEmbedded(null)}>{t('character_editor.cancel_embedded_tags')}</button>
              </div>
            </section>}
          </div>
        </div>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {uncertain && <p role="status">{t('character_editor.acknowledgement_uncertain_the_save_may_have_reached')}</p>}
      {stale && !uncertain && <CharacterReconciliation library={library} characterId={initial.id} disabled={busy || pending} reconcile={reconcile} />}
      {stale && dirty && <CopyLibraryDraft editor={draft} />}
      {uncertain && <button type="button" disabled={busy || pending} onClick={() => void save(uncertain)}>{t('character_editor.retry_same_save')}</button>}
      <EditorActions formId={formId} disabled={draftControlsDisabled || processing || stale} cancelDisabled={busy || pending} close={close} />
    </form>
    {manager && <TagManager library={library} busy={busy || pending} run={run} committed={committed} close={() => setManager(false)} />}
  </NumberDraftContext.Provider>;
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
  const helpId = useId();
  const label = t('character_editor.card_instructions');
  const numberDraft = useContext(NumberDraftContext);
  const [open, setOpen] = useState(() => Boolean(change && numberDraft?.values.characterDepth !== undefined));
  const note = readCharacterDepthPrompt(value);
  const instructions = open ? cardInstructionFields.map(field => ({
    field, instruction: readCardInstruction(value, field), label: cardInstructionLabel(field),
  })) : [];
  const warnings = instructions.flatMap(({ instruction, label }) => instruction.success ? []
    : [msg("character_editor.is_invalid_the_preserved_value_will_remain", { label })]);
  if (!note.success) warnings.push(msg("character_editor.the_character_depth_note_has_invalid_settings"));
  function instructionField({ field, instruction, label }: typeof instructions[number]) {
    if (!instruction.success) return <div className="full" key={field}>
      {change && <button type="button" className="secondary" onClick={() => change({ ...value, [field]: '' })}>{t("character_editor.clear_invalid", { value: label.toLowerCase() })}</button>}
    </div>;
    if (!change) return <p className="prose small full" key={field}>{label}: {instruction.data || t("character_editor.empty")}</p>;
    return <label className="full" key={field}>{label}
      <EditorTextarea aria-label={label} maxLength={100_000} value={instruction.data} onChange={event => change({ ...value, [field]: event.target.value })} />
    </label>;
  }
  return <details className="editor-disclosure library-editor-disclosure" open={open} onToggle={event => {
    const expanded = event.currentTarget.open;
    if (change && !expanded) numberDraft?.set('characterDepth', undefined);
    setOpen(expanded);
  }}>
    <summary aria-label={label} aria-describedby={helpId}>
      <span><span>{label}</span><small className="muted" id={helpId}>{t('character_editor.the_prompt_preset_controls_whether_these_instructions')}</small></span>
      <Icon name="ArrowShortBottom" />
    </summary>
    {open && <div className="form-grid editor-disclosure-content">
      {warnings.length > 0 && <div className="full"><WarningMessages messages={warnings} /></div>}
      {instructions.map(instructionField)}
      {!note.success ? <div className="full">
        {change && <button type="button" className="secondary" onClick={() => change({ ...value, depth_prompt: { prompt: '', depth: 2, role: 'system' } })}>{t("character_editor.clear_invalid_character_depth_note")}</button>}
      </div> : change ? <>
        <label className="full">{t("character_editor.character_depth_note")}<EditorTextarea aria-label={t("character_editor.character_depth_note_2")} maxLength={100_000} value={note.data.prompt} onChange={event => change({ ...value, depth_prompt: { ...note.data, prompt: event.target.value } })} />
        </label>
        <label className="library-editor-setting character-note-depth"><span>{t("character_editor.character_note_depth")}</span><NumberInput draftField="characterDepth" aria-label={t("character_editor.character_note_depth_2")} required min={0} max={1000} value={note.data.depth} onChange={depth => change({ ...value, depth_prompt: { ...note.data, depth } })} />
        </label>
        <label>{t("character_editor.character_note_role")}<Dropdown aria-label={t("character_editor.character_note_role_2")} value={note.data.role} onChange={role => {
            if (role === 'system' || role === 'user' || role === 'assistant') change({ ...value, depth_prompt: { ...note.data, role } });
          }} options={['system', 'user', 'assistant'].map(role => ({ value: role, label: stateLabel(role === 'system' || role === 'user' ? role : 'assistant') }))} />
        </label>
        <p className="small muted full character-editor-help">{t("character_editor.depth_0_follows_the_newest_history_message")}</p>
      </> : <p className="prose small full">{t("character_editor.character_depth_note_depth", { role: note.data.role, depth: note.data.depth, value: note.data.prompt || t("character_editor.empty") })}</p>}
    </div>}
  </details>;
}
