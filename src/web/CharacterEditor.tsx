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
  const [error, setError] = useState(''), [pending, setPending] = useState(false);
  const originalRevision = useRef(library.characters.find(character => character.id === initial.id)?.revision);
  const alive = useRef(true), extractionId = useRef(crypto.randomUUID());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const stale = revision !== library.revision;
  const greetings = readCharacterAlternateGreetings(data);
  const alternatives = greetings.success ? greetings.data : [];
  const characterChanged = (['name', 'titleComment', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'lorebookId', 'system_prompt', 'post_history_instructions'] as const).some(field => data[field] !== baselineData[field])
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
    if (initial.id && (character?.revision !== originalRevision.current || (character?.titleComment ?? '') !== (baselineData.titleComment ?? '') || (snapshot.characterPictures.find(picture => picture.characterId === initial.id)?.key ?? null) !== (baselinePicture?.key ?? null) || expected.length !== links.length || expected.some(id => !links.includes(id)))) return;
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
        if (!alive.current || embedded.revision !== revision || snapshot.revision !== result.revision || snapshot.characters.find(card => card.id === initial.id)?.revision !== originalRevision.current || (snapshot.characters.find(card => card.id === initial.id)?.titleComment ?? '') !== (baselineData.titleComment ?? '') || (snapshot.characterPictures.find(picture => picture.characterId === initial.id)?.key ?? null) !== (baselinePicture?.key ?? null)) return;
        const links = snapshot.characterTags.filter(link => link.characterId === initial.id).map(link => link.tagId);
        setTagIds(ids => [...new Set([...ids, ...links.filter(id => !baseline.includes(id))])]);
        setBaseline(links); setRevision(result.revision); setEmbedded(null);
      } catch (error) { setError(error instanceof Error ? error.message : 'Could not apply embedded tags.'); throw error; }
    });
    setPending(false);
  }
  async function save(frozen?: CharacterSaveCommand) {
    if (submitting.current || processing || (uncertain && !frozen)) return;
    submitting.current = true; setPending(true); setError('');
    const command: CharacterSaveCommand = frozen ?? { kind: 'characters', requestId: crypto.randomUUID(), revision, data: structuredClone(data), tagIds: [...tagIds], expectedPicture: baselinePicture?.key ?? null, picture: pictureMutation(picture, baselinePicture) };
    setUncertain(command);
    const ok = await run(async () => {
      try { await api(initial.id ? `/library/${initial.id}` : '/library', initial.id ? 'PUT' : 'POST', command); }
      catch (error) {
        if (alive.current) {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) { setUncertain(null); setError(error.message); }
          else setError('The acknowledgement is uncertain. Retry the same save to recover its recorded result.');
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
    <form id={formId} onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy || pending || stale || Boolean(uncertain)}><legend>{initial.id ? 'Edit' : 'Create'} character</legend><div className="form-grid">
      <label>Name<input required maxLength={100} value={data.name} onChange={event => setData({ ...data, name: event.target.value })} /></label>
      <label>Title / comment<input aria-label="Title / comment" maxLength={200} value={data.titleComment ?? ''} onChange={event => setData({ ...data, titleComment: event.target.value })} /><small>An optional label, useful for distinguishing between versions.</small></label>
      <PictureEditor value={picture} change={setPicture} original={baselinePicture} disabled={busy || pending || stale || Boolean(uncertain)} processing={setProcessing} />
      {([['description', 'Character description'], ['personality', 'Personality'], ['scenario', 'Scenario'], ['first_mes', 'Greeting'], ['mes_example', 'Example dialogue']] as const).map(([field, label]) => <label key={field} className="full">{label}<EditorTextarea aria-label={label} maxLength={100_000} value={data[field]} onChange={event => setData({ ...data, [field]: event.target.value })} /></label>)}
      <CardInstructions value={data} change={setData} />
      <div className="full" role="group" aria-label="Alternate greetings">
        <h3>Alternate greetings</h3>
        {!greetings.success && <p role="alert">The preserved alternate greetings are invalid. They will be retained on save and export. Clear them before adding replacements or starting a new chat with this character.</p>}
        {alternatives.map((greeting, index) => <div className="alternate-greeting" key={index}>
          <label>Alternate greeting {index + 1}<EditorTextarea aria-label={`Alternate greeting ${index + 1}`} maxLength={100_000} value={greeting} onChange={event => setData({ ...data, alternate_greetings: alternatives.map((text, position) => position === index ? event.target.value : text) })} /></label>
          <button type="button" className="quiet" aria-label={`Remove alternate greeting ${index + 1}`} onClick={() => setData({ ...data, alternate_greetings: alternatives.filter((_, position) => position !== index) })}>Remove greeting</button>
        </div>)}
        {greetings.success ? <button type="button" className="secondary add-alternate-greeting" disabled={alternatives.length >= maxAlternateGreetings} onClick={() => setData({ ...data, alternate_greetings: [...alternatives, ''] })}>Add alternate greeting</button>
          : <button type="button" className="secondary" onClick={() => setData({ ...data, alternate_greetings: [] })}>Clear invalid alternate greetings</button>}
      </div>
      <label className="full">Default lorebook<Dropdown aria-label="Default lorebook" value={data.lorebookId ?? ''} options={[{ value: '', label: 'None selected' }, ...library.lorebooks.map(book => ({ value: book.id, label: book.name }))]} onChange={id => setData({ ...data, lorebookId: id || null })} /></label>
      {data.lorebookId && <button type="button" className="secondary" onClick={() => { const bookId = data.lorebookId; if (!bookId) return; if (!characterChanged && !pictureChanged && tagIds.join() === baseline.join()) openBook(bookId); else confirmAction({ title: 'Discard character edits?', message: 'Open the book and discard unsaved character edits?', actionLabel: 'Discard edits', onConfirm: () => openBook(bookId) }); }}>Open book</button>}
      {initial.id && !data.lorebookId && embeddedBook && <div className="full"><button type="button" className="secondary" disabled={characterChanged || pictureChanged || tagIds.join() !== baseline.join()} onClick={async () => { let bookId = ''; if (await run(async () => { bookId = (await api<{ bookId: string }>(`/library/characters/${initial.id}/extract`, 'POST', { revision, requestId: extractionId.current })).bookId; })) extracted(bookId); }}>Extract embedded lorebook</button><p className="small muted">Save character edits first. Extraction creates and links an independent library book.</p></div>}
      <div className="full"><TagChooser label="Assign tags" tags={library.tags} selected={tagIds} change={setTagIds} /><button type="button" className="secondary" onClick={() => setManager(true)}>Manage tags</button>
        {initial.id && <button type="button" className="quiet" onClick={async () => { setPending(true); await run(async () => { const preview = await api<{ revision: number; tags: TagReview }>(`/library/characters/${initial.id}/tags/preview`); if (alive.current) { setEmbedded(preview); setPolicy('none'); } }); setPending(false); }}>Review embedded tags</button>}
      </div>
    </div></fieldset>{error && <p role="alert">{error}</p>}{uncertain && <p role="status">Acknowledgement uncertain. The save may have reached the server. Retry same save sends the frozen text, tags, file and crop. Closing does not undo a saved change.</p>}{stale && !uncertain && <CharacterReconciliation library={library} characterId={initial.id} disabled={busy || pending} reconcile={reconcile} />}<EditorActions><button type="submit" form={formId} disabled={busy || pending || processing || stale || Boolean(uncertain)}>Save character</button>{uncertain && <button type="button" disabled={busy || pending} onClick={() => void save(uncertain)}>Retry same save</button>}<button type="button" className="quiet" disabled={pending} onClick={safeClose} title="Close editor"><Icon name="Close" /><span className="sr-only">Close editor</span></button></EditorActions></form>
    {manager && <TagManager library={library} busy={busy || pending} run={run} committed={committed} close={() => setManager(false)} />}
    {embedded && <section className="character-import-review"><h2>Review embedded tags</h2><p className="small">This saves only local tags, preserving your character draft. Existing local assignments are never removed.</p><TagImportOptions review={embedded.tags} policy={policy} change={setPolicy} disabled={busy || pending} /><button type="button" disabled={busy || pending || stale || embedded.revision !== revision || Boolean(embedded.tags.modes[policy].blocked)} onClick={() => void applyEmbedded()}>Apply reviewed tags</button><button type="button" className="quiet" onClick={() => setEmbedded(null)}>Cancel embedded tags</button></section>}
  </>;
}

function CharacterReconciliation({ library, characterId, disabled, reconcile }: { library: LibrarySnapshot; characterId?: string; disabled: boolean; reconcile: () => void }) {
  const character = library.characters.find(card => card.id === characterId);
  const picture = library.characterPictures.find(picture => picture.characterId === characterId);
  const selectedTags = new Set(library.characterTags.filter(link => link.characterId === characterId).map(link => link.tagId));
  const greetings = character ? readCharacterAlternateGreetings(character) : null;
  const greetingTexts = greetings?.success ? greetings.data : null;
  return <section className="character-reconcile">
    <p role="status">The library changed. Your unsaved edits and picture draft remain here.</p>
    {characterId && <>
      <p className="small">Current saved character: {character ? characterLabel(character) : 'Deleted'} · {selectedTags.size} tags. Review current text and tags before reapplying your picture.</p>
      <PictureSquare url={picture?.thumbnailUrl} />
      {character && <details><summary>Current saved text and tags</summary>
        {(['name', 'titleComment', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'] as const).map((field, index) => <div key={field}><strong>{['Name', 'Title / comment', 'Description', 'Personality', 'Scenario', 'Greeting', 'Example dialogue'][index]}</strong><p className="prose small">{character[field] || 'Empty'}</p></div>)}
        <CardInstructions value={character} />
        <strong>Alternate greetings</strong>
        {greetingTexts === null && <p>Invalid preserved alternate greetings; raw metadata is retained.</p>}
        {greetingTexts?.length === 0 && <p>None</p>}
        {greetingTexts?.map((text, index) => <div key={index}><strong>Alternate greeting {index + 1}</strong><p className="prose small">{text || 'Empty'}</p></div>)}
        <strong>Default lorebook</strong><p>{library.lorebooks.find(book => book.id === character.lorebookId)?.name ?? 'None'}</p>
        <strong>Tags</strong><p>{library.tags.filter(tag => selectedTags.has(tag.id)).map(tag => tag.name).join(', ') || 'None'}</p>
      </details>}
    </>}
    <button type="button" className="secondary" disabled={disabled || Boolean(characterId && !character)} onClick={reconcile}>Use current text and tags; keep my picture draft</button>
    <p className="small muted">This replaces local text/tag edits with the saved values shown above. Your picture and crop stay in the draft. Review them, then Save character.</p>
  </section>;
}

function CardInstructions({ value, change }: { value: LibraryCharacter; change?: (value: LibraryCharacter) => void }) {
  const [open, setOpen] = useState(false);
  const note = readCharacterDepthPrompt(value);
  function instructionField(field: typeof cardInstructionFields[number]) {
    const instruction = readCardInstruction(value, field);
    const label = cardInstructionLabels[field];
    if (!instruction.success) return <div className="full" key={field}>
      <p role="alert">{label} is invalid. The preserved value will remain until explicitly cleared.</p>
      {change && <button type="button" className="secondary" onClick={() => change({ ...value, [field]: '' })}>Clear invalid {label.toLowerCase()}</button>}
    </div>;
    if (!change) return <p className="prose small full" key={field}>{label}: {instruction.data || 'Empty'}</p>;
    return <label className="full" key={field}>{label}
      <EditorTextarea aria-label={label} maxLength={100_000} value={instruction.data} onChange={event => change({ ...value, [field]: event.target.value })} />
    </label>;
  }
  return <details className="full card-instructions" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Card instructions</summary>
    {open && <div className="form-grid">
      <p className="small muted full">The Prompt preset controls whether these instructions are sent. Character notes use their configured depth and role when Messages permits injection.</p>
      {cardInstructionFields.map(instructionField)}
      {!note.success ? <div className="full">
        <p role="alert">The character depth note has invalid settings. The preserved value will remain until explicitly cleared. Clearing replaces malformed note metadata on export.</p>
        {change && <button type="button" className="secondary" onClick={() => change({ ...value, depth_prompt: { prompt: '', depth: 2, role: 'system' } })}>Clear invalid character depth note</button>}
      </div> : change ? <>
        <label className="full">Character depth note
          <EditorTextarea aria-label="Character depth note" maxLength={100_000} value={note.data.prompt} onChange={event => change({ ...value, depth_prompt: { ...note.data, prompt: event.target.value } })} />
        </label>
        <label>Character note depth
          <NumberInput aria-label="Character note depth" required min={0} max={1000} value={note.data.depth} onChange={depth => change({ ...value, depth_prompt: { ...note.data, depth } })} />
        </label>
        <label>Character note role
          <Dropdown aria-label="Character note role" value={note.data.role} onChange={role => {
            if (role === 'system' || role === 'user' || role === 'assistant') change({ ...value, depth_prompt: { ...note.data, role } });
          }} options={['system', 'user', 'assistant'].map(role => ({ value: role, label: role }))} />
        </label>
        <p className="small muted full">Depth 0 follows the newest history message; depth 1 precedes it. Depth counts nonblank outgoing history messages. Larger depths stop at the oldest included message.</p>
      </> : <p className="prose small full">Character depth note ({note.data.role}, depth {note.data.depth}): {note.data.prompt || 'Empty'}</p>}
    </div>}
  </details>;
}
