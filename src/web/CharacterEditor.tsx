import { useEffect, useRef, useState } from 'react';
import type { Character, LibrarySnapshot } from '../shared/library';
import type { TagPolicy, TagReview } from '../shared/tags';
import { api } from './api';
import { Dropdown } from './Controls';
import { TagChooser, TagImportOptions, TagManager, type TagCommit } from './Tags';

type Initial = { id?: string; revision: number; data: Character };
export function CharacterEditor({ initial, library, busy, run, close, openBook, extracted, saved }: { initial: Initial; library: LibrarySnapshot; busy: boolean; run: (action: () => Promise<unknown>) => Promise<boolean>; close: () => void; openBook: (id: string) => void; extracted: (id: string) => void; saved: () => void }) {
  const [data, setData] = useState(initial.data), [revision, setRevision] = useState(initial.revision);
  const [baseline, setBaseline] = useState(() => library.characterTags.filter(link => link.characterId === initial.id).map(link => link.tagId));
  const [tagIds, setTagIds] = useState(baseline), [manager, setManager] = useState(false);
  const [embedded, setEmbedded] = useState<{ revision: number; tags: TagReview } | null>(null), [policy, setPolicy] = useState<TagPolicy>('none');
  const [error, setError] = useState(''), [pending, setPending] = useState(false);
  const originalRevision = useRef(library.characters.find(character => character.id === initial.id)?.revision);
  const alive = useRef(true), extractionId = useRef(crypto.randomUUID());
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const stale = revision !== library.revision;
  const characterChanged = (['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'lorebookId'] as const).some(field => data[field] !== initial.data[field]);
  function safeClose() { alive.current = false; close(); }
  const committed: TagCommit = (before, after, snapshot, deletedId) => {
    if (!alive.current || before !== revision || snapshot.revision !== after) return;
    const character = snapshot.characters.find(character => character.id === initial.id);
    const links = snapshot.characterTags.filter(link => link.characterId === initial.id).map(link => link.tagId);
    const expected = baseline.filter(id => id !== deletedId);
    // Advance only our own checked organizational mutation, with the editor's
    // actual character and assignment dependencies still unchanged.
    if (initial.id && (character?.revision !== originalRevision.current || expected.length !== links.length || expected.some(id => !links.includes(id)))) return;
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
        if (!alive.current || embedded.revision !== revision || snapshot.revision !== result.revision || snapshot.characters.find(card => card.id === initial.id)?.revision !== originalRevision.current) return;
        const links = snapshot.characterTags.filter(link => link.characterId === initial.id).map(link => link.tagId);
        setTagIds(ids => [...new Set([...ids, ...links.filter(id => !baseline.includes(id))])]);
        setBaseline(links); setRevision(result.revision); setEmbedded(null);
      } catch (error) { setError(error instanceof Error ? error.message : 'Could not apply embedded tags.'); throw error; }
    });
    setPending(false);
  }
  const source = initial.data.source ?? {};
  const nested = source.data;
  const embeddedBook = source.spec === 'chara_card_v2' || source.spec === 'chara_card_v3' ? typeof nested === 'object' && nested !== null && 'character_book' in nested : source.character_book !== undefined;
  return <>
    <form onSubmit={async event => {
      event.preventDefault(); if (pending) return; setPending(true); setError('');
      const ok = await run(async () => {
        try { await api(initial.id ? `/library/${initial.id}` : '/library', initial.id ? 'PUT' : 'POST', { kind: 'characters', revision, data, tagIds }); }
        catch (error) { setError(error instanceof Error ? error.message : 'Could not save character.'); throw error; }
      });
      setPending(false); if (ok && alive.current) { saved(); safeClose(); }
    }}><fieldset disabled={busy || pending || stale}><legend>{initial.id ? 'Edit' : 'Create'} character</legend><div className="form-grid">
      <label className="full">Name<input required maxLength={100} value={data.name} onChange={event => setData({ ...data, name: event.target.value })} /></label>
      {([['description', 'Character description'], ['personality', 'Personality'], ['scenario', 'Scenario'], ['first_mes', 'Greeting'], ['mes_example', 'Example dialogue']] as const).map(([field, label]) => <label key={field} className="full">{label}<textarea aria-label={label} maxLength={100_000} value={data[field]} onChange={event => setData({ ...data, [field]: event.target.value })} /></label>)}
      <label className="full">Default lorebook<Dropdown aria-label="Default lorebook" value={data.lorebookId ?? ''} options={[{ value: '', label: 'None selected' }, ...library.lorebooks.map(book => ({ value: book.id, label: book.name }))]} onChange={id => setData({ ...data, lorebookId: id || null })} /><small>Prefills new chats; existing chats keep their selection. This linked book is embedded on export.</small></label>
      {data.lorebookId && <button type="button" className="secondary" onClick={() => { if (data.lorebookId && (!characterChanged && tagIds.join() === baseline.join() || confirm('Open the book and discard unsaved character edits?'))) openBook(data.lorebookId); }}>Open book</button>}
      {initial.id && !data.lorebookId && embeddedBook && <div className="full"><button type="button" className="secondary" disabled={characterChanged || tagIds.join() !== baseline.join()} onClick={async () => { let bookId = ''; if (await run(async () => { bookId = (await api<{ bookId: string }>(`/library/characters/${initial.id}/extract`, 'POST', { revision, requestId: extractionId.current })).bookId; })) extracted(bookId); }}>Extract embedded lorebook</button><p className="small muted">Save character edits first. Extraction creates and links an independent library book.</p></div>}
      <div className="full"><TagChooser label="Assign tags" tags={library.tags} selected={tagIds} change={setTagIds} /><button type="button" className="secondary" onClick={() => setManager(true)}>Manage tags</button>
        {initial.id && <button type="button" className="quiet" onClick={async () => { setPending(true); await run(async () => { const preview = await api<{ revision: number; tags: TagReview }>(`/library/characters/${initial.id}/tags/preview`); if (alive.current) { setEmbedded(preview); setPolicy('none'); } }); setPending(false); }}>Apply embedded tags</button>}
      </div><p className="small muted full">Assignments are a draft until Save. Use {'{{user}}'} and {'{{char}}'} for names. Imported metadata stays preserved for export.</p>
    </div></fieldset>{error && <p role="alert">{error}</p>}{stale && <p role="status">The library changed. Your unsaved edits remain here. Close and reopen this editor to reconcile before saving.</p>}<div className="actions"><button disabled={busy || pending || stale}>Save character</button><button type="button" className="quiet" disabled={pending} onClick={safeClose}>Close editor</button></div></form>
    {manager && <TagManager library={library} busy={busy || pending} run={run} committed={committed} close={() => setManager(false)} />}
    {embedded && <section className="character-import-review"><h2>Apply embedded tags</h2><p className="small">This saves only local tags, preserving your character draft. Existing local assignments are never removed.</p><TagImportOptions review={embedded.tags} policy={policy} change={setPolicy} disabled={busy || pending} /><button type="button" disabled={busy || pending || stale || embedded.revision !== revision || Boolean(embedded.tags.modes[policy].blocked)} onClick={() => void applyEmbedded()}>Apply reviewed tags</button><button type="button" className="quiet" onClick={() => setEmbedded(null)}>Cancel embedded tags</button></section>}
  </>;
}
