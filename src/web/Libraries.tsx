import { PictureSquare } from './Pictures';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ChatSnapshot, Connection, ConnectionDiagnostic } from '../shared/contracts';
import { characterFields, characterFieldLabels, defaultPrompt, markers, promptWarnings, type Character, type LibraryKind, type LibrarySnapshot, type Persona, type PromptBlock, type PromptPreset, type Saved } from '../shared/library';
import { upgradePrompt } from '../core/prompt-upgrade';
import { importChat } from '../core/chat-import';
import { CharacterImport } from './CharacterImport';
import { CharacterEditor } from './CharacterEditor';
import { TagChips, TagFilterMenu } from './Tags';
import { characterTagIndex, matchesCharacterTags } from '../shared/tags';
import { api } from './api';
import { Dropdown, NumberInput } from './Controls';
import { defaultContextPreset, type ContextPreset } from '../shared/context';
import { newLorebook, type Lorebook, type LoreDiagnostic } from '../shared/lorebook';
import { LorebookEditor, LorebookImport, LoreDiagnostics } from './LorebookEditor';

export const defaultConnection: Connection = { name: 'My Connection', endpoint: 'https://api.openai.com/v1', model: '', contextWindow: 128_000, maxOutputTokens: 2048, customParameters: {} };
type Run = (action: () => Promise<unknown>) => Promise<boolean>;
type Selection = { title: string; targetInputTokens: number; connectionId: string | null; promptId: string; characterId: string | null; personaId: string | null; contextPresetId: string | null; lorebookId: string | null };
type LibraryRecord = Character | Persona | PromptPreset | Connection | ContextPreset | Lorebook;
const libraryLabels: Record<LibraryKind | 'chats', string> = {
  chats: 'Chats',
  personas: 'Personas',
  characters: 'Characters',
  lorebooks: 'Lorebooks',
  prompts: 'Prompts',
  connections: 'Connections',
  contexts: 'Context presets',
};
function selection(snapshot?: ChatSnapshot, library?: LibrarySnapshot): Selection {
  return { title: snapshot?.settings.title ?? 'A new story', targetInputTokens: snapshot?.settings.targetInputTokens ?? 32_000,
    connectionId: snapshot ? snapshot.settings.connectionId ?? null : library?.connections[0]?.id ?? null, promptId: snapshot?.settings.promptId ?? 'default',
    characterId: snapshot?.settings.characterId ?? null, personaId: snapshot?.settings.personaId ?? null, contextPresetId: snapshot?.settings.contextPresetId ?? null, lorebookId: snapshot?.settings.lorebookId ?? null };
}
function SelectionFields({ value, change, library }: { value: Selection; change: (value: Selection) => void; library: LibrarySnapshot }) {
  return <div className="form-grid">
    <label>Chat title<input required maxLength={100} value={value.title} onChange={e => change({ ...value, title: e.target.value })} /></label>
    <label>Target input tokens<NumberInput required value={value.targetInputTokens} onChange={targetInputTokens => change({ ...value, targetInputTokens })} /></label>
    {(['connectionId', 'promptId', 'characterId', 'personaId', 'contextPresetId', 'lorebookId'] as const).map((key, i) => {
      const names = ['Connection', 'Prompt preset', 'Character', 'Persona', 'Context preset', 'Lorebook'];
      const lists = [library.connections, library.prompts, library.characters, library.personas, library.contexts, library.lorebooks];
      return <label key={key}>{names[i]}<Dropdown aria-label={names[i]} value={value[key] ?? ''} onChange={selected => change({ ...value, [key]: selected || null })} options={[...(key !== 'promptId' ? [{ value: '', label: 'None selected' }] : []), ...lists[i].map(item => ({ value: item.id, label: item.name }))]} /></label>;
    })}
  </div>;
}
function NewChat({ library, busy, run, created, cancel }: { library: LibrarySnapshot; busy: boolean; run: Run; created: (id: string) => void; cancel: () => void }) {
  const [characterId, setCharacterId] = useState<string | null>(null);
  const [personaId, setPersonaId] = useState<string | null>(null);
  const submitting = useRef(false);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || submitting.current) return;
    submitting.current = true;
    try {
      const character = library.characters.find(item => item.id === characterId);
      // Keep the Roleplay suffix within the existing 100-character chat-title limit.
      const suffix = ' - Roleplay';
      const title = character ? `${character.name.slice(0, 100 - suffix.length)}${suffix}` : 'A new story';
      const settings = { ...selection(undefined, library), title, characterId, personaId, lorebookId: character?.lorebookId ?? null };
      let id = '';
      if (await run(async () => { id = (await api<{ id: string }>('/chats', 'POST', settings)).id; })) created(id);
    } finally {
      submitting.current = false;
    }
  }
  return <form onSubmit={create}><fieldset disabled={busy}><legend>New chat</legend>
    <div className="form-grid">
      <label>Character<Dropdown aria-label="Character" value={characterId ?? ''} onChange={id => setCharacterId(id || null)} options={[{ value: '', label: 'None selected' }, ...library.characters.map(item => ({ value: item.id, label: item.name }))]} /></label>
      <label>Persona<Dropdown aria-label="Persona" value={personaId ?? ''} onChange={id => setPersonaId(id || null)} options={[{ value: '', label: 'None selected' }, ...library.personas.map(item => ({ value: item.id, label: item.name }))]} /></label>
    </div>
    <div className="actions"><button>Create chat</button><button type="button" className="quiet" onClick={cancel}>Cancel</button></div>
  </fieldset></form>;
}
export function ChatSetup({ snapshot, library, busy, run, saved }: { snapshot: ChatSnapshot; library: LibrarySnapshot; busy: boolean; run: Run; saved: () => void }) {
  const [value, setValue] = useState(() => selection(snapshot, library));
  const [revision] = useState(snapshot.revision);
  return <main className="document-panel"><p className="eyebrow">CHAT SETUP</p><h1>Choose this story’s ingredients.</h1><p className="muted">Each chat keeps its own selections. Edit reusable cards, prompts and Connections in Libraries; saved changes apply to chats using them.</p>
    <form onSubmit={async e => { e.preventDefault(); if (await run(() => api(`/chats/${snapshot.id}/selections`, 'PUT', { revision, settings: value }))) saved(); }}><fieldset disabled={busy}><legend>Selections</legend><SelectionFields value={value} change={setValue} library={library} /></fieldset>
      <p className="small muted">With Summary enabled, a context preset prepares older history. Without Summary, Messages uses recent whole turns that fit the input limit. Missing markers send no content. Changing a character preserves the selected lorebook, greeting and saved turns. Changing character or persona starts fresh lore activation history for this chat.</p>
      {revision !== snapshot.revision && <p role="status">This chat changed. Reopen Setup to load its current settings.</p>}
      <button disabled={busy || revision !== snapshot.revision}>Save setup</button>
    </form><HistoryImport snapshot={snapshot} busy={busy} run={run} />
  </main>;
}
async function* fileChunks(file: File) {
  const reader = file.stream().getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  try { while (true) { const { done, value } = await reader.read(); if (done) break; yield decoder.decode(value, { stream: true }); } yield decoder.decode(); }
  finally { reader.releaseLock(); }
}
function HistoryImport({ snapshot, busy, run }: { snapshot: ChatSnapshot; busy: boolean; run: Run }) {
  const [imported, setImported] = useState<Awaited<ReturnType<typeof importChat>> | null>(null);
  const [revision, setRevision] = useState(snapshot.revision), [error, setError] = useState(''), [reading, setReading] = useState(false), [filename, setFilename] = useState('');
  return <section className="import-panel"><h2>Replace chat messages from a file</h2><p className="muted small">Choose a SillyTavern JSONL export. The file is read locally; only active message text is uploaded. Existing messages, saved memory and request records are replaced together after review. Lore activation history starts fresh. Chat selections stay as they are.</p>
    <label>Chat JSONL file<input type="file" accept=".jsonl" disabled={busy || reading} onChange={async e => {
      const file = e.target.files?.[0]; setImported(null); setError(''); if (!file) return;
      setReading(true); setFilename(file.name); setRevision(snapshot.revision);
      try { if (file.size > 128_000_000) throw new Error('Choose an export smaller than 128 MB.'); setImported(await importChat(fileChunks(file))); }
      catch (err) { setError(err instanceof Error ? err.message : 'Could not read this file.'); } finally { setReading(false); }
    }} /></label>
    {reading && <p role="status">Reading message text…</p>}{error && <p role="alert">{error}</p>}
    {imported && <div className="budget"><strong>{filename}: {imported.messages} messages → {imported.turns.length} turns</strong><span>{imported.extraTurns} additional turns preserve consecutive same-speaker messages. {imported.turns.at(-1)?.complete ? 'All turns are complete.' : 'The final user turn will await a response.'}</span><small>Old summaries, memory state, alternate swipes and hidden-from-context flags are not imported. Every active message is preserved, including intentionally blank text. No character greeting is added.</small><p>This replaces {snapshot.turns.length} existing turns and their request records.</p><button disabled={busy || revision !== snapshot.revision} onClick={async () => { if (await run(() => api(`/chats/${snapshot.id}/history`, 'PUT', { revision, turns: imported.turns }))) { setImported(null); setFilename(''); } }}>Replace all messages</button>{revision !== snapshot.revision && <span role="status">The chat changed. Select the file again to review the current replacement.</span>}</div>}
  </section>;
}
function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function matchesSearch(value: string, query: string): boolean {
  return value.normalize('NFC').toLowerCase().includes(query);
}
function matchesLibraryRecord(record: LibraryRecord, query: string): boolean {
  if (!query || matchesSearch(record.name, query)) return true;
  const matches = (value: string) => matchesSearch(value, query);
  if ('description' in record && matches(record.description)) return true;
  if ('model' in record && matches(record.model)) return true;
  return 'entries' in record && record.entries.some(entry => matches(entry.name) || matches(entry.comment) || matches(entry.content) || entry.keys.some(matches) || entry.secondaryKeys.some(matches));
}
function LibrarySearch({ section, value, change }: { section: LibraryKind | 'chats'; value: string; change: (value: string) => void }) {
  const label = `Search ${libraryLabels[section].toLowerCase()}`;
  return <div className="library-search">
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
    <input type="search" aria-label={label} placeholder={label} value={value} onChange={event => change(event.target.value)} />
  </div>;
}
export function Libraries({ library, currentChatId, busy, run, openChat }: { library: LibrarySnapshot; currentChatId: string | null; busy: boolean; run: Run; openChat: (id: string, destination?: 'story' | 'settings') => void }) {
  const [section, setSection] = useState<LibraryKind | 'chats'>('chats');
  const [editing, setEditing] = useState<{ kind: LibraryKind; id?: string; revision: number; data: LibraryRecord; hasApiKey?: boolean } | null>(null);
  const [creatingChat, setCreatingChat] = useState(false);
  const [notice, setNotice] = useState(''), [diagnostics, setDiagnostics] = useState<LoreDiagnostic[]>([]), [search, setSearch] = useState('');
  const [pendingBook, setPendingBook] = useState<string | null>(null);
  const [filters, setFilters] = useState<string[]>([]);
  const [lastImported, setLastImported] = useState<string | null>(null);
  const pictureIndex = useMemo(() => new Map(library.characterPictures.map(picture => [picture.characterId, picture])), [library.characterPictures]);
  const tagCatalog = useMemo(() => new Map(library.tags.map(tag => [tag.id, tag])), [library.tags]);
  const tagIndex = useMemo(() => characterTagIndex(library.characterTags), [library.characterTags]);
  useEffect(() => { const ids = new Set(library.tags.map(tag => tag.id)); setFilters(previous => previous.filter(id => ids.has(id))); }, [library.tags]);
  const query = search.normalize('NFC').toLowerCase();
  const visibleChats = useMemo(() => library.chats.filter(chat => matchesSearch(chat.title, query)), [library.chats, query]);
  const visibleRecords = useMemo<Saved<LibraryRecord>[]>(() => {
    if (section === 'chats') return [];
    return library[section].filter(record => matchesLibraryRecord(record, query)
      && (section !== 'characters' || matchesCharacterTags(tagIndex.get(record.id), filters)));
  }, [section, library, query, tagIndex, filters]);
  useEffect(() => {
    if (!pendingBook) return;
    const book = library.lorebooks.find(item => item.id === pendingBook);
    if (!book) return;
    const { id, revision: _revision, ...data } = book;
    setFilters([]); setSearch(''); setSection('lorebooks'); setEditing({ kind: 'lorebooks', id, revision: library.revision, data }); setPendingBook(null);
  }, [pendingBook, library]);
  function openBook(id: string) {
    const book = library.lorebooks.find(item => item.id === id);
    if (!book) { setNotice('The lorebook is not yet loaded. Reopen Lorebooks after the library refreshes.'); return; }
    const { id: bookId, revision: _revision, ...data } = book;
    setFilters([]); setSearch(''); setSection('lorebooks'); setEditing({ kind: 'lorebooks', id: bookId, revision: library.revision, data });
  }
  function create() {
    const kind = section as LibraryKind;
    const data = kind === 'lorebooks' ? newLorebook() : kind === 'connections' ? defaultConnection : kind === 'contexts' ? structuredClone(defaultContextPreset) : kind === 'prompts' ? { ...structuredClone(defaultPrompt), name: 'New prompt' } : kind === 'personas' ? { name: '', description: '' } : { name: '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', lorebookId: null };
    setEditing({ kind, revision: library.revision, data });
  }
  return <main className="library-layout">
    <aside className="library-sidebar">
      <p className="eyebrow">YOUR LIBRARIES</p>
      <nav className="library-tabs" aria-label="Library categories">
        {(['chats', 'personas', 'characters', 'lorebooks', 'prompts', 'connections', 'contexts'] as const).map(kind => <button
          type="button"
          aria-pressed={section === kind}
          key={kind}
          onClick={() => {
            if (kind !== 'characters') setFilters([]);
            setSection(kind);
            setEditing(null);
            setCreatingChat(false);
            setNotice('');
            setDiagnostics([]);
            setSearch('');
          }}
        >{libraryLabels[kind]}</button>)}
      </nav>
    </aside>
    <section key={section} className="document-panel library-panel" aria-labelledby="library-heading">
    <h1 id="library-heading">{libraryLabels[section]}</h1>
    {notice && <p role="status">{notice}</p>}<LoreDiagnostics diagnostics={diagnostics} />
    {section === 'chats' ? <>
      <div className="actions library-toolbar" role="group" aria-label="Library actions"><button disabled={busy || creatingChat} onClick={() => setCreatingChat(true)}>New chat</button></div>
      {!creatingChat && <LibrarySearch section={section} value={search} change={setSearch} />}
      {creatingChat && <NewChat library={library} busy={busy} run={run} created={id => { setCreatingChat(false); openChat(id, 'settings'); }} cancel={() => setCreatingChat(false)} />}
      <div className="library-list">{visibleChats.map(item => <article key={item.id}><div><h2>{item.title}</h2><p>{item.turnCount} turns{item.running ? ' · Response running' : ''}{currentChatId === item.id ? ' · Current chat' : ''}</p></div><div className="actions"><button className="secondary" onClick={() => openChat(item.id)}>Open chat</button><button className="quiet" disabled={busy || item.running} onClick={() => { if (confirm(`Delete “${item.title}” and all its turns and requests?`)) void run(() => api(`/chats/${item.id}`, 'DELETE', { revision: item.revision })); }}>Delete chat</button></div></article>)}{library.chats.length === 0 && <p className="muted">Create a chat to start your next story.</p>}{query && visibleChats.length === 0 && library.chats.length > 0 && <p className="muted" role="status">No chats match your search.</p>}</div>
    </> : <>
      {!editing && section !== 'characters' && section !== 'lorebooks' && <div className="actions library-toolbar" role="group" aria-label="Library actions"><button disabled={busy} onClick={create}>New {section === 'personas' ? 'persona' : section === 'prompts' ? 'prompt' : section === 'contexts' ? 'context preset' : 'Connection'}</button>
        {(section === 'personas') && <label className="file-button">Import personas<input type="file" accept=".json" disabled={busy} onChange={async e => {
          const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
          await run(async () => {
            if (file.size > 2_000_000) throw new Error('Card imports are limited to 2 MB.');
            const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
            const result = await api<{ ids: string[]; books?: { id: string; name: string; entries: number }[]; diagnostics?: LoreDiagnostic[] }>('/library/import', 'POST', { revision: library.revision, requestId: crypto.randomUUID(), kind: section, base64: btoa(binary) });
            setNotice(`Imported ${result.ids.length} persona(s).${result.books?.map(book => ` Lorebook “${book.name}”: ${book.entries} entries.`).join('') ?? ''}`); setDiagnostics(result.diagnostics ?? []);
          });
        }} /></label>}
        {(section === 'prompts' || section === 'contexts') && <label className="file-button">Import {section === 'contexts' ? 'context preset' : 'prompt'}<input type="file" accept=".json" disabled={busy} onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) await run(async () => { if (file.size > 1_000_000) throw new Error('Preset file is too large.'); const value: unknown = JSON.parse(await file.text()); await api('/library', 'POST', { kind: section, revision: library.revision, data: section === 'prompts' ? upgradePrompt(value) : value }); }); }} /></label>}
      </div>}
      {!editing && section === 'lorebooks' && <LorebookImport leadingAction={<button disabled={busy} onClick={create}>New lorebook</button>} revision={library.revision} busy={busy} run={run} imported={(_id, message) => setNotice(message)} />}
      {section === 'characters' && <><CharacterImport hidden={Boolean(editing)} leadingAction={<button disabled={busy} onClick={create}>New character</button>} trailingAction={!editing && <TagFilterMenu library={library} busy={busy} run={run} selected={filters} change={setFilters} />} revision={library.revision} busy={busy} run={run} imported={(result, missing) => { setLastImported(missing ? null : result.ids[0] ?? null); setNotice(missing ? 'The original import was saved, but its character is no longer available. A deliberate new import requires selecting the file again.' : `Imported ${result.ids.length} character.${result.books.map(book => ` Lorebook “${book.name}”: ${book.entries} entries.`).join('')}${result.tags ? ` ${result.tags.assigned} local tags assigned; ${result.tags.created} created.` : ' Original tag report unavailable.'}${result.picture ? result.picture.saved ? ' Picture saved.' : ' No picture saved.' : ' Original picture report unavailable.'}${filters.length ? ' The character may be hidden by your tag filters.' : ''}`); setDiagnostics(result.diagnostics); }} />{!editing && lastImported && library.characters.some(card => card.id === lastImported) && <button type="button" className="secondary" onClick={() => { const card = library.characters.find(card => card.id === lastImported); if (card) { const { id, revision: _revision, ...data } = card; setEditing({ kind: 'characters', id, revision: library.revision, data }); } }}>Edit imported character / Adjust crop</button>}</>}
      {editing ? editing.kind === 'characters' && 'personality' in editing.data ? <CharacterEditor key={editing.id ?? 'new-character'} initial={{ ...editing, data: editing.data }} library={library} busy={busy} run={run} close={() => setEditing(null)} openBook={openBook} saved={() => setNotice(`Character saved.${filters.length ? ' It may be hidden by your tag filters.' : ''}`)} extracted={id => { setEditing(null); setFilters([]); setSection('lorebooks'); setNotice('Embedded lorebook extracted. Review its shared library entries.'); setPendingBook(id); }} /> : editing.kind === 'lorebooks' && 'entries' in editing.data ? <LorebookEditor key={editing.id ?? editing.kind} initial={{ ...editing, data: editing.data }} currentRevision={library.revision} busy={busy} run={run} close={() => setEditing(null)} /> : <LibraryEditor key={editing.id ?? editing.kind} initial={editing} connections={library.connections} currentRevision={library.revision} busy={busy} run={run} close={() => setEditing(null)} /> : <>
      <LibrarySearch section={section} value={search} change={setSearch} />
      {section === 'characters' && filters.length > 0 && <div className="character-active-filters" aria-label="Active tag filters" role="group">
        <TagChips tags={library.tags} catalog={tagCatalog} selected={filters} remove={id => setFilters(filters.filter(value => value !== id))} />
        <button type="button" className="quiet" onClick={() => setFilters([])}>Clear filters</button>
        <span className="small muted" role="status">{visibleRecords.length} of {library.characters.length} characters</span>
      </div>}
      <div className={`library-list${section === 'characters' ? ' character-list' : ''}`}>{visibleRecords.map(item => <article key={item.id}>{section === 'characters' && <PictureSquare url={pictureIndex.get(item.id)?.thumbnailUrl} />}<div className={section === 'characters' ? 'character-row-content' : undefined}><h2>{item.name}{item.id === 'default' ? ' · Built in' : ''}</h2>{section === 'characters' && 'description' in item ? <CharacterDescription text={item.description} /> : <p>{section === 'connections' ? (item as Saved<Connection>).model : section === 'prompts' ? `${(item as Saved<PromptPreset>).blocks.length} blocks` : section === 'contexts' ? `Minimum tail ${(item as Saved<ContextPreset>).minTail} · Batch ${(item as Saved<ContextPreset>).batchSize}` : 'description' in item ? item.description.slice(0, 140) : ''}</p>}{section === 'lorebooks' && 'entries' in item && <><p>{item.entries.length} entries · {item.entries.filter(entry => entry.enabled).length} enabled</p><LorebookUses bookId={item.id} library={library} /></>}</div><div className="actions">
        <button className="secondary" aria-label={section === 'characters' ? `Edit ${item.name}` : undefined} disabled={busy} onClick={() => { const { id, revision: _revision, ...record } = item; const { hasApiKey, ...data } = record as typeof record & { hasApiKey?: boolean }; setEditing({ kind: section, id, revision: library.revision, data, hasApiKey }); }}>Edit</button>
        <button className="quiet" aria-label={section === 'characters' ? `Duplicate ${item.name}` : undefined} disabled={busy} onClick={() => void run(async () => { const { id: _id, revision: _revision, ...record } = item; const { hasApiKey: _key, ...data } = record as typeof record & { hasApiKey?: boolean }; if (section === 'characters') await api(`/library/characters/${item.id}/duplicate`, 'POST', { revision: library.revision }); else await api('/library', 'POST', { kind: section, revision: library.revision, data: { ...data, name: `${item.name.slice(0, 90)} copy`, ...('entries' in data ? { entries: data.entries.map(entry => ({ ...entry, id: crypto.randomUUID() })) } : {}) } }); setNotice(section === 'connections' ? 'Connection copied. Add its API key in the new Connection.' : section === 'characters' && 'lorebookId' in data && data.lorebookId ? 'Character copied. Its default lorebook is shared with the original character; duplicate the book for independent edits.' : section === 'lorebooks' ? 'Independent lorebook copy saved.' : 'Copy saved.'); })}>Duplicate</button>
        {section !== 'connections' && <button className="quiet" aria-label={section === 'characters' ? `Export JSON ${item.name}` : undefined} onClick={() => void run(async () => download(await api(`/library/${section}/${item.id}/export`), `${item.name.replace(/[^a-z0-9_-]/gi, '_')}.json`))}>{section === 'characters' ? 'Export JSON' : 'Export'}</button>}
        {item.id === 'default' && <button className="quiet" disabled={busy} onClick={() => { if (confirm('Restore the built-in default prompt? Chats selecting it will use the restored prompt.')) void run(() => api('/library/default/restore', 'POST', { revision: library.revision })); }}>Restore original</button>}
        {item.id !== 'default' && <button className="quiet" aria-label={section === 'characters' ? `Delete ${item.name}` : undefined} disabled={busy || (section === 'lorebooks' && library.lorebookUses.some(use => use.bookId === item.id && (use.characters.length > 0 || use.chats.length > 0)))} onClick={() => { if (confirm(`Delete “${item.name}” from the library?`)) void run(() => api(`/library/${item.id}`, 'DELETE', { kind: section, revision: library.revision })); }}>Delete</button>}
      </div></article>)}{library[section].length === 0 && <p className="muted">Create or import your first {section === 'lorebooks' ? 'lorebook' : section === 'personas' ? 'persona' : section === 'characters' ? 'character' : section === 'connections' ? 'Connection' : 'prompt'}.</p>}{section !== 'characters' && query && visibleRecords.length === 0 && library[section].length > 0 && <p className="muted" role="status">No {libraryLabels[section].toLowerCase()} match your search.</p>}</div>
      {section === 'characters' && library.characters.length > 0 && visibleRecords.length === 0 && <p role="status">{query ? filters.length ? 'No characters match your search and selected tags.' : 'No characters match your search.' : 'No characters match all selected tags. Clear filters to see every character.'}</p>}
      </>}
    </>}
    </section>
  </main>;
}
function CharacterDescription({ text }: { text: string }) {
  const node = useRef<HTMLParagraphElement>(null), [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = node.current; if (!element) return;
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1);
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  return <p ref={node} className={`character-description${overflow ? ' overflows' : ''}`}>{text}</p>;
}
function LorebookUses({ bookId, library }: { bookId: string; library: LibrarySnapshot }) {
  const use = library.lorebookUses.find(item => item.bookId === bookId);
  return use && (use.characters.length > 0 || use.chats.length > 0) ? <p className="small">Used by {use.characters.map(character => `character “${character.name}”`).concat(use.chats.map(chat => `chat “${chat.title}”`)).join(', ')}. Unlink these selections before deleting.</p> : <p className="small">No character or chat links.</p>;
}
function LibraryEditor({ initial, connections, currentRevision, busy, run, close }: { initial: { kind: LibraryKind; id?: string; revision: number; data: LibraryRecord; hasApiKey?: boolean }; connections: Saved<Connection>[]; currentRevision: number; busy: boolean; run: Run; close: () => void }) {
  const [data, setData] = useState(initial.data), [key, setKey] = useState(''), [removeKey, setRemoveKey] = useState(false);
  const [parameters, setParameters] = useState(JSON.stringify((initial.data as Connection).customParameters ?? {}, null, 2));
  const [error, setError] = useState('');
  const [models, setModels] = useState<string[]>([]), [fetchingModels, setFetchingModels] = useState(false), [modelNotice, setModelNotice] = useState('');
  const discovery = useRef(0);
  function resetModels() { discovery.current++; setModels([]); setFetchingModels(false); setModelNotice(''); }
  async function loadModels() {
    const attempt = ++discovery.current;
    setFetchingModels(true); setModelNotice('');
    try {
      const result = await api<{ models: string[] }>('/models', 'POST', { endpoint: (data as Connection).endpoint, ...(initial.id ? { connectionId: initial.id } : {}), ...(key || removeKey ? { apiKey: removeKey ? '' : key } : {}) });
      if (attempt === discovery.current) { setModels(result.models); setModelNotice(result.models.length ? `${result.models.length} models available. Type to filter.` : 'The provider returned an empty model list. Enter a model identifier from your provider’s documentation manually.'); }
    } catch (error) { if (attempt === discovery.current) { setModels([]); setModelNotice(error instanceof Error ? error.message : 'Could not fetch models. Check the API base URL and API key, then try again.'); } }
    finally { if (attempt === discovery.current) setFetchingModels(false); }
  }
  const stale = initial.revision !== currentRevision;
  async function save(e: FormEvent) {
    e.preventDefault(); setError('');
    let value = data;
    try { if (initial.kind === 'connections') value = { ...data as Connection, customParameters: JSON.parse(parameters) }; }
    catch { setError('Custom parameters must be valid JSON.'); return; }
    if (await run(() => api(initial.id ? `/library/${initial.id}` : '/library', initial.id ? 'PUT' : 'POST', { revision: initial.revision, kind: initial.kind, data: value, ...(initial.kind === 'connections' && (key || removeKey) ? { apiKey: removeKey ? '' : key } : {}) }))) close();
  }
  function textField(field: string, label: string, multiline = true) {
    const value = (data as unknown as Record<string, string>)[field];
    return <label className="full" key={field}>{label}{multiline ? <textarea value={value} maxLength={100_000} onChange={e => setData({ ...data, [field]: e.target.value })} /> : <input required maxLength={100} value={value} onChange={e => setData({ ...data, [field]: e.target.value })} />}</label>;
  }
  return <form onSubmit={e => void save(e)}><fieldset disabled={busy || stale}><legend>{initial.id ? 'Edit' : 'Create'} {initial.kind === 'connections' ? 'Connection' : initial.kind.slice(0, -1)}</legend><div className="form-grid">{textField('name', 'Name', false)}
    {initial.kind === 'personas' && textField('description', 'Persona description')}
    {initial.kind === 'contexts' && <ContextPresetFields value={data as ContextPreset} change={setData} connections={connections} />}
    {initial.kind === 'connections' && <>
      <div className="full model-field"><label>Model identifier<Dropdown editable required aria-label="Model identifier" value={(data as Connection).model} onChange={model => setData({ ...data as Connection, model })} options={models.map(model => ({ value: model, label: model }))} /></label><button className="secondary" type="button" disabled={fetchingModels || !(data as Connection).endpoint} onClick={() => void loadModels()}>{fetchingModels ? 'Fetching…' : 'Fetch model list'}</button><p className="small muted">If your provider requires an API key, enter it below before fetching models. A saved key is used automatically. You can also enter a model identifier from your provider’s documentation.</p>{modelNotice && <p className="small muted" role="status">{modelNotice}</p>}</div>
      <label className="full">API base URL<input type="url" required value={(data as Connection).endpoint} onChange={e => { setData({ ...data as Connection, endpoint: e.target.value }); resetModels(); }} /></label>
      <div className="full api-key-row"><label>API key<input type="password" autoComplete="new-password" disabled={removeKey} placeholder={initial.hasApiKey ? 'Saved · leave blank to keep it' : 'Optional for endpoints without authentication'} value={key} onChange={e => { setKey(e.target.value); resetModels(); }} /></label>{initial.hasApiKey && <label className="checkbox"><input type="checkbox" checked={removeKey} onChange={e => { setRemoveKey(e.target.checked); resetModels(); }} />Remove the saved API key</label>}</div>
      <label>Model context window<NumberInput required value={(data as Connection).contextWindow} onChange={contextWindow => setData({ ...data as Connection, contextWindow })} /></label><label>Reserved output tokens<NumberInput required max={1_000_000} value={(data as Connection).maxOutputTokens} onChange={maxOutputTokens => setData({ ...data as Connection, maxOutputTokens })} /></label><label className="checkbox full"><input type="checkbox" checked={(data as Connection).requestUsage !== false} onChange={e => setData({ ...data as Connection, requestUsage: e.target.checked })} />Request token usage from the endpoint</label><p className="small muted full">Turn statistics use counts supplied by the endpoint. Disable this if your endpoint rejects streaming usage requests.</p><label className="full">Custom request parameters<textarea className="code-input" value={parameters} onChange={e => setParameters(e.target.value)} /><small>temperature, top_p, presence_penalty, frequency_penalty, seed, stop and reasoning_effort.</small></label>
      <ConnectionTools connection={data as Connection} parameters={parameters} connectionId={initial.id} apiKey={removeKey ? '' : key || undefined} />
    </>}
    {initial.kind === 'prompts' && <div className="full"><p className="small muted">Enabled blocks and markers compose the base prompt. The chat’s selected lorebook inserts matching entries beside included character fields or within Messages. Character expands checked fields into separate messages. Text blocks and card fields support {'{{user}}'} and {'{{char}}'}. Without Summary, Messages uses recent whole turns that fit the input limit.</p><PromptEditor value={data as PromptPreset} change={setData} /></div>}
  </div></fieldset>{error && <p role="alert">{error}</p>}{stale && <p role="status">The library changed. Close this editor and reopen it before saving.</p>}<div className="actions"><button disabled={busy || stale}>Save {initial.kind === 'connections' ? 'Connection' : initial.kind.slice(0, -1)}</button><button type="button" className="quiet" onClick={close}>Close editor</button></div></form>;
}
function ConnectionTools({ connection, parameters, connectionId, apiKey }: { connection: Connection; parameters: string; connectionId?: string; apiKey?: string }) {
  const [result, setResult] = useState<ConnectionDiagnostic | null>(null), [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const attempt = useRef(0);
  const signature = JSON.stringify([connection, parameters, connectionId, apiKey]);
  useEffect(() => {
    attempt.current++; setResult(null); setError(''); setTesting(false);
  }, [signature]);
  useEffect(() => () => { attempt.current++; }, []);
  async function diagnose(action: 'check' | 'test') {
    const id = ++attempt.current; setTesting(true); setResult(null); setError('');
    try {
      const value = await api<ConnectionDiagnostic>('/connections/diagnose', 'POST', { action, connection: { ...connection, customParameters: JSON.parse(parameters) }, connectionId, apiKey });
      if (attempt.current === id) setResult(value);
    } catch (error) { if (attempt.current === id) setError(error instanceof Error ? error.message : 'Connection test failed.'); }
    finally { if (attempt.current === id) setTesting(false); }
  }
  return <div className="full connection-tools">
    <div className="actions"><button type="button" className="secondary" disabled={testing} onClick={() => void diagnose('check')}>Check connection</button><button type="button" className="secondary" disabled={testing} onClick={() => void diagnose('test')}>Send test message</button></div>
    <p className="small muted connection-help">Enter your provider’s API key above first, unless a key is already saved or your provider allows access without one. “Check connection” fetches the model list. “Send test message” sends “Hi” using your Reserved output tokens setting; provider charges may apply. These actions use your current entries without saving settings or chat history.</p>
    {testing && <p className="small" role="status">Testing connection…</p>}
    {error && <p role="alert">{error}</p>}
    {result && <div className="connection-test-result" role="status"><p className="small connection-success">{result.message}</p>{result.request && <><p className="small">{result.usage ? `Token usage: ${result.usage.inputTokens.toLocaleString()} input / ${result.usage.outputTokens.toLocaleString()} output.` : 'Token usage unavailable.'}</p><details><summary>Test request and response</summary><pre>{JSON.stringify({ request: result.request, response: result.response, usage: result.usage }, null, 2)}</pre></details></>}</div>}
  </div>;
}
function ContextPresetFields({ value, change, connections }: { value: ContextPreset; change: (value: ContextPreset) => void; connections: Saved<Connection>[] }) {
  const fields = [['minTail', 'Minimum verbatim turns', 0], ['batchSize', 'Turns per batch', 1], ['summaryTokens', 'Requested summary tokens', 1], ['promotionGroup', 'Summaries per promotion', 2], ['retainedPerLevel', 'Retain summaries per level', 0]] as const;
  return <><label className="full">Summarization Connection<Dropdown aria-label="Summarization Connection" value={value.connectionId ?? ''} onChange={connectionId => change({ ...value, connectionId: connectionId || null })} options={[{ value: '', label: 'Select a Connection' }, ...connections.map(connection => ({ value: connection.id, label: `${connection.name} · ${connection.model}` }))]} /></label>
    {fields.map(([field, label, min]) => <label key={field}>{label}<NumberInput required min={min} max={field === 'summaryTokens' ? 1_000_000 : 50_000} value={value[field]} onChange={number => change({ ...value, [field]: number })} /></label>)}
    <p className="small muted full">The input target belongs to each chat. Summary size is a prompt target; the Connection reserves output separately. Preparation stops when input fits. Promotion uses actual layer sizes and protects the newest summaries at each level.</p>
    <label className="full">First-layer extraction prompt<textarea required value={value.extractionPrompt} maxLength={100_000} onChange={e => change({ ...value, extractionPrompt: e.target.value })} /></label>
    <label className="full">Higher-layer compression prompt<textarea required value={value.promotionPrompt} maxLength={100_000} onChange={e => change({ ...value, promotionPrompt: e.target.value })} /></label>
    <label className="full">Repair prompt<textarea required value={value.repairPrompt} maxLength={100_000} onChange={e => change({ ...value, repairPrompt: e.target.value })} /></label>
    <p className="small muted full">Repair receives the existing summary and before/after versions of changed inputs. Exactly unchanged results are saved automatically when coverage is unchanged; changed text awaits review. Downstream memory is reused without a model only when all of its consumed content is unchanged.</p>
    <p className="small muted full">Available variables: {'{{target_tokens}}'}, {'{{level}}'}, {'{{user}}'}, {'{{char}}'}. Source text is attached separately. Extraction and compression include up to three earlier selected summaries when they fit. Repair keeps the original dependencies and includes every changed input, or stops if they cannot fit. Saved requests keep their original prompts; edits apply to future work.</p>
  </>;
}
function PromptEditor({ value, change }: { value: PromptPreset; change: (value: PromptPreset) => void }) {
  const [dragged, setDragged] = useState<number | null>(null), [dropPosition, setDropPosition] = useState<number | null>(null);
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(() => new Set());
  function update(index: number, block: PromptBlock) { change({ ...value, blocks: value.blocks.map((old, i) => i === index ? block : old) }); }
  function move(from: number, to: number) { if (to < 0 || to >= value.blocks.length || from === to) return; const blocks = [...value.blocks]; blocks.splice(to, 0, blocks.splice(from, 1)[0]); change({ ...value, blocks }); }
  function boundary(element: HTMLElement, y: number) {
    const index = [...element.children].findIndex(child => { const rect = child.getBoundingClientRect(); return y < rect.top + rect.height / 2; });
    return index < 0 ? value.blocks.length : index;
  }
  function endDrag() { setDragged(null); setDropPosition(null); }
  return <>{promptWarnings(value).map(warning => <p className="small" role="status" key={warning}>{warning}</p>)}<div className="prompt-blocks" onDragOver={event => {
    if (dragged === null || event.currentTarget.closest('fieldset')?.disabled) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDropPosition(boundary(event.currentTarget, event.clientY));
  }} onDrop={event => {
    event.preventDefault();
    if (dragged !== null && !event.currentTarget.closest('fieldset')?.disabled) { const position = boundary(event.currentTarget, event.clientY); move(dragged, position > dragged ? position - 1 : position); }
    endDrag();
  }} onDragLeave={event => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) setDropPosition(null);
  }}>{value.blocks.map((block, index) => {
    const expanded = expandedBlocks.has(block.id);
    return <section className={`prompt-block${dragged === index ? ' dragging' : ''}${dropPosition === index ? ' drop-before' : ''}${index === value.blocks.length - 1 && dropPosition === value.blocks.length ? ' drop-after' : ''}`} aria-label={`Prompt block ${index + 1}`} key={block.id}>
      <div className="block-heading">
        <span draggable onDragStart={event => { if (event.currentTarget.closest('fieldset')?.disabled) { event.preventDefault(); return; } event.dataTransfer.setData('text/plain', block.id); event.dataTransfer.effectAllowed = 'move'; setDragged(index); }} onDragEnd={endDrag} title="Drag to reorder" className="drag-handle" aria-label={`Drag block ${index + 1}`}>⠿</span>
        <input type="checkbox" aria-label={`Enable block ${index + 1}`} checked={block.enabled} onChange={event => update(index, { ...block, enabled: event.target.checked })} />
        <label className="block-name">Block name<input required value={block.name} onChange={event => update(index, { ...block, name: event.target.value })} /></label>
        <label className="block-role">Role<Dropdown aria-label={`Role for block ${index + 1}`} disabled={block.kind === 'marker' && block.marker === 'messages'} value={block.role} onChange={role => update(index, { ...block, role: role as PromptBlock['role'] })} options={['system', 'user', 'assistant'].map(role => ({ value: role, label: role }))} /></label>
        <div className="block-actions"><button type="button" className="quiet" aria-label={`Move block ${index + 1} up`} disabled={index === 0} onClick={() => move(index, index - 1)}>↑</button><button type="button" className="quiet" aria-label={`Move block ${index + 1} down`} disabled={index === value.blocks.length - 1} onClick={() => move(index, index + 1)}>↓</button><button type="button" className="quiet" aria-label={`Remove block ${index + 1}`} onClick={() => change({ ...value, blocks: value.blocks.filter((_, i) => i !== index) })}>Remove</button><button type="button" className="quiet block-toggle" aria-expanded={expanded} aria-controls={`block-content-${block.id}`} aria-label={`${expanded ? 'Collapse' : 'Expand'} block ${index + 1}`} onClick={() => setExpandedBlocks(old => { const next = new Set(old); if (expanded) next.delete(block.id); else next.add(block.id); return next; })}>{expanded ? '⌃' : '⌄'}</button></div>
      </div>
      {expanded && <div className="block-content" id={`block-content-${block.id}`}>
        {block.kind === 'text' ? <label>Block text<textarea value={block.text} onChange={event => update(index, { ...block, text: event.target.value })} /></label> : <>
          <label>Marker source<Dropdown aria-label={`Marker source for block ${index + 1}`} value={block.marker} onChange={selected => {
            const marker = markers.find(marker => marker === selected);
            if (!marker || marker === block.marker) return;
            const { fields: _fields, ...base } = block;
            update(index, { ...base, marker, ...(marker === 'character' ? { fields: [...characterFields] } : {}) });
          }} options={markers.map(marker => ({ value: marker, label: marker[0].toUpperCase() + marker.slice(1) }))} /></label>
          {block.marker === 'character' && <MarkerFieldSelection label="Included character fields" options={characterFields.map(field => ({ value: field, label: characterFieldLabels[field] }))} selected={block.fields ?? [...characterFields]} change={fields => update(index, { ...block, fields })} />}
        </>}
      </div>}
    </section>;
  })}</div><div className="actions"><button type="button" className="secondary" disabled={value.blocks.length >= 100} onClick={() => change({ ...value, blocks: [...value.blocks, { id: crypto.randomUUID(), name: 'Text', enabled: true, kind: 'text', role: 'system', text: '' }] })}>Add text block</button><button type="button" className="secondary" disabled={value.blocks.length >= 100} onClick={() => change({ ...value, blocks: [...value.blocks, { id: crypto.randomUUID(), name: 'Marker', enabled: true, kind: 'marker', role: 'system', marker: 'description' }] })}>Add marker</button></div></>;
}

function MarkerFieldSelection<T extends string>({ label, options, selected, change }: { label: string; options: readonly { value: T; label: string }[]; selected: readonly T[]; change: (selected: T[]) => void }) {
  return <fieldset className="marker-fields"><legend>{label}</legend><p className="small muted">Checked fields become separate messages in this order, using the marker’s role. Empty fields are omitted.</p><div className="marker-field-options">{options.map(option => <label className="checkbox" key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={event => change(options.filter(candidate => candidate.value === option.value ? event.target.checked : selected.includes(candidate.value)).map(candidate => candidate.value))} />{option.label}</label>)}</div></fieldset>;
}
