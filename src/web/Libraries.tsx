import { useRef, useState, type FormEvent } from 'react';
import type { ChatSnapshot, Connection } from '../shared/contracts';
import { defaultPrompt, markers, type Character, type LibraryKind, type LibrarySnapshot, type Persona, type PromptBlock, type PromptPreset, type Saved } from '../shared/library';
import { importChat } from '../core/chat-import';
import { api } from './api';
import { Dropdown, NumberInput } from './Controls';

export const defaultConnection: Connection = { name: 'My Connection', endpoint: 'https://api.openai.com/v1', model: '', contextWindow: 128_000, maxOutputTokens: 2048, customParameters: {} };
type Run = (action: () => Promise<unknown>) => Promise<boolean>;
type Selection = { title: string; targetInputTokens: number; connectionId: string | null; promptId: string; characterId: string | null; personaId: string | null };
function selection(snapshot?: ChatSnapshot, library?: LibrarySnapshot): Selection {
  return { title: snapshot?.settings.title ?? 'A new story', targetInputTokens: snapshot?.settings.targetInputTokens ?? 32_000,
    connectionId: snapshot ? snapshot.settings.connectionId ?? null : library?.connections[0]?.id ?? null, promptId: snapshot?.settings.promptId ?? 'default',
    characterId: snapshot?.settings.characterId ?? null, personaId: snapshot?.settings.personaId ?? null };
}
function SelectionFields({ value, change, library }: { value: Selection; change: (value: Selection) => void; library: LibrarySnapshot }) {
  return <div className="form-grid">
    <label>Chat title<input required maxLength={100} value={value.title} onChange={e => change({ ...value, title: e.target.value })} /></label>
    <label>Target input tokens<NumberInput required value={value.targetInputTokens} onChange={targetInputTokens => change({ ...value, targetInputTokens })} /></label>
    {(['connectionId', 'promptId', 'characterId', 'personaId'] as const).map((key, i) => {
      const names = ['Connection', 'Prompt preset', 'Character', 'Persona'];
      const lists = [library.connections, library.prompts, library.characters, library.personas];
      return <label key={key}>{names[i]}<Dropdown aria-label={names[i]} value={value[key] ?? ''} onChange={selected => change({ ...value, [key]: selected || null })} options={[...(key !== 'promptId' ? [{ value: '', label: 'None selected' }] : []), ...lists[i].map(item => ({ value: item.id, label: item.name }))]} /></label>;
    })}
  </div>;
}
export function ChatSetup({ snapshot, library, busy, run, saved }: { snapshot: ChatSnapshot; library: LibrarySnapshot; busy: boolean; run: Run; saved: () => void }) {
  const [value, setValue] = useState(() => selection(snapshot, library));
  const [revision] = useState(snapshot.revision);
  return <main className="document-panel"><p className="eyebrow">CHAT SETUP</p><h1>Choose this story’s ingredients.</h1><p className="muted">Each chat keeps its own selections. Edit reusable cards, prompts and Connections in Libraries; saved changes apply to chats using them.</p>
    <form onSubmit={async e => { e.preventDefault(); if (await run(() => api(`/chats/${snapshot.id}/selections`, 'PUT', { revision, settings: value }))) saved(); }}><fieldset disabled={busy}><legend>Selections</legend><SelectionFields value={value} change={setValue} library={library} /></fieldset>
      <p className="small muted">Full history is included. Summary markers stay empty until layered compaction is available. Changing a character does not rewrite the greeting or saved turns.</p>
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
  return <section className="import-panel"><h2>Replace chat messages from a file</h2><p className="muted small">Choose a SillyTavern JSONL export. The file is read locally; only active message text is uploaded. Existing messages and their request records are replaced together after review. Chat selections stay as they are.</p>
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
export function Libraries({ library, currentChatId, busy, run, openChat }: { library: LibrarySnapshot; currentChatId: string | null; busy: boolean; run: Run; openChat: (id: string) => void }) {
  const [section, setSection] = useState<LibraryKind | 'chats'>('chats');
  const [editing, setEditing] = useState<{ kind: LibraryKind; id?: string; revision: number; data: Character | Persona | PromptPreset | Connection; hasApiKey?: boolean } | null>(null);
  const [creatingChat, setCreatingChat] = useState(false), [chat, setChat] = useState(() => selection(undefined, library));
  const [notice, setNotice] = useState('');
  function create() {
    const kind = section as LibraryKind;
    const data = kind === 'connections' ? defaultConnection : kind === 'prompts' ? { ...structuredClone(defaultPrompt), name: 'New prompt' } : kind === 'personas' ? { name: '', description: '' } : { name: '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '' };
    setEditing({ kind, revision: library.revision, data });
  }
  return <main className="document-panel library-panel"><p className="eyebrow">YOUR LIBRARIES</p><h1>Build a place to return to.</h1>
    <div className="library-tabs" role="group" aria-label="Libraries">{(['chats', 'personas', 'characters', 'prompts', 'connections'] as const).map(kind => <button className="secondary" aria-pressed={section === kind} key={kind} onClick={() => { setSection(kind); setEditing(null); setCreatingChat(false); setNotice(''); }}>{kind[0].toUpperCase() + kind.slice(1)}</button>)}</div>
    {notice && <p role="status">{notice}</p>}
    {section === 'chats' ? <>
      <button disabled={busy} onClick={() => { setCreatingChat(true); setChat(selection(undefined, library)); }}>New chat</button>
      {creatingChat && <form onSubmit={async e => { e.preventDefault(); let id = ''; if (await run(async () => { id = (await api<{ id: string }>('/chats', 'POST', chat)).id; })) { setCreatingChat(false); openChat(id); } }}><fieldset disabled={busy}><legend>New story</legend><SelectionFields value={chat} change={setChat} library={library} /><div className="actions"><button>Create chat</button><button type="button" className="quiet" onClick={() => setCreatingChat(false)}>Cancel</button></div></fieldset></form>}
      <div className="library-list">{library.chats.map(item => <article key={item.id}><div><h2>{item.title}</h2><p>{item.turnCount} turns{item.running ? ' · Response running' : ''}{currentChatId === item.id ? ' · Current chat' : ''}</p></div><div className="actions"><button className="secondary" onClick={() => openChat(item.id)}>Open chat</button><button className="quiet" disabled={busy || item.running} onClick={() => { if (confirm(`Delete “${item.title}” and all its turns and requests?`)) void run(() => api(`/chats/${item.id}`, 'DELETE', { revision: item.revision })); }}>Delete chat</button></div></article>)}{library.chats.length === 0 && <p className="muted">Create a chat to start your next story.</p>}</div>
    </> : <>
      {!editing && <div className="actions"><button disabled={busy} onClick={create}>New {section === 'personas' ? 'persona' : section === 'characters' ? 'character' : section === 'prompts' ? 'prompt' : 'Connection'}</button>
        {(section === 'characters' || section === 'personas') && <label className="file-button">Import {section === 'characters' ? 'character' : 'personas'}<input type="file" accept={section === 'characters' ? '.json,.png' : '.json'} disabled={busy} onChange={async e => {
          const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
          await run(async () => {
            if (file.size > 2_000_000) throw new Error('Card imports are limited to 2 MB.');
            const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
            const result = await api<{ ids: string[] }>('/library/import', 'POST', { revision: library.revision, kind: section, base64: btoa(binary) });
            setNotice(`Imported ${result.ids.length} ${section === 'characters' ? 'character' : 'persona(s)'}.`);
          });
        }} /></label>}
        {section === 'prompts' && <label className="file-button">Import prompt<input type="file" accept=".json" disabled={busy} onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) await run(async () => { if (file.size > 1_000_000) throw new Error('Prompt file is too large.'); await api('/library', 'POST', { kind: 'prompts', revision: library.revision, data: JSON.parse(await file.text()) }); }); }} /></label>}
      </div>}
      {editing ? <LibraryEditor key={editing.id ?? editing.kind} initial={editing} currentRevision={library.revision} busy={busy} run={run} close={() => setEditing(null)} /> : <div className="library-list">{library[section].map(item => <article key={item.id}><div><h2>{item.name}{item.id === 'default' ? ' · Built in' : ''}</h2><p>{section === 'connections' ? (item as Saved<Connection>).model : section === 'prompts' ? `${(item as Saved<PromptPreset>).blocks.length} blocks` : 'description' in item ? item.description.slice(0, 140) : ''}</p></div><div className="actions">
        <button className="secondary" disabled={busy} onClick={() => { const { id, revision: _revision, ...record } = item; const { hasApiKey, ...data } = record as typeof record & { hasApiKey?: boolean }; setEditing({ kind: section, id, revision: library.revision, data, hasApiKey }); }}>Edit</button>
        <button className="quiet" disabled={busy} onClick={() => void run(async () => { const { id: _id, revision: _revision, ...record } = item; const { hasApiKey: _key, ...data } = record as typeof record & { hasApiKey?: boolean }; await api('/library', 'POST', { kind: section, revision: library.revision, data: { ...data, name: `${item.name.slice(0, 90)} copy` } }); setNotice(section === 'connections' ? 'Connection copied. Add its API key in the new Connection.' : 'Copy saved.'); })}>Duplicate</button>
        {section !== 'connections' && <button className="quiet" onClick={() => void run(async () => download(await api(`/library/${section}/${item.id}/export`), `${item.name.replace(/[^a-z0-9_-]/gi, '_')}.json`))}>Export</button>}
        {item.id === 'default' && <button className="quiet" disabled={busy} onClick={() => { if (confirm('Restore the built-in default prompt? Chats selecting it will use the restored prompt.')) void run(() => api('/library/default/restore', 'POST', { revision: library.revision })); }}>Restore original</button>}
        {item.id !== 'default' && <button className="quiet" disabled={busy} onClick={() => { if (confirm(`Delete “${item.name}” from the library?`)) void run(() => api(`/library/${item.id}`, 'DELETE', { kind: section, revision: library.revision })); }}>Delete</button>}
      </div></article>)}{library[section].length === 0 && <p className="muted">Create or import your first {section === 'personas' ? 'persona' : section === 'characters' ? 'character' : section === 'connections' ? 'Connection' : 'prompt'}.</p>}</div>}
    </>}
  </main>;
}
function LibraryEditor({ initial, currentRevision, busy, run, close }: { initial: { kind: LibraryKind; id?: string; revision: number; data: Character | Persona | PromptPreset | Connection; hasApiKey?: boolean }; currentRevision: number; busy: boolean; run: Run; close: () => void }) {
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
      if (attempt === discovery.current) { setModels(result.models); setModelNotice(result.models.length ? `${result.models.length} models available. Type to filter.` : 'No models returned. Enter a model identifier manually.'); }
    } catch (error) { if (attempt === discovery.current) { setModels([]); setModelNotice(error instanceof Error ? error.message : 'Could not fetch models. Enter a model identifier manually.'); } }
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
    {initial.kind === 'characters' && <>{[['description', 'Character description'], ['personality', 'Personality'], ['scenario', 'Scenario'], ['first_mes', 'Greeting'], ['mes_example', 'Example dialogue']].map(([field, label]) => textField(field, label))}<p className="small muted full">Supports basic V1/V2 text fields. Lorebooks, alternate greetings and other imported V2 fields are preserved for export but are not used by generation. Use {'{{user}}'} and {'{{char}}'} for names.</p></>}
    {initial.kind === 'connections' && <>
      <div className="full model-field"><label>Model identifier<Dropdown editable required aria-label="Model identifier" value={(data as Connection).model} onChange={model => setData({ ...data as Connection, model })} options={models.map(model => ({ value: model, label: model }))} /></label><button className="secondary" type="button" disabled={fetchingModels || !(data as Connection).endpoint} onClick={() => void loadModels()}>{fetchingModels ? 'Fetching…' : 'Fetch model list'}</button>{modelNotice && <p className="small muted" role="status">{modelNotice}</p>}</div>
      <label className="full">API base URL<input type="url" required value={(data as Connection).endpoint} onChange={e => { setData({ ...data as Connection, endpoint: e.target.value }); resetModels(); }} /></label>
      <div className="full api-key-row"><label>API key<input type="password" autoComplete="new-password" disabled={removeKey} placeholder={initial.hasApiKey ? 'Saved · leave blank to keep it' : 'Optional for endpoints without authentication'} value={key} onChange={e => { setKey(e.target.value); resetModels(); }} /></label>{initial.hasApiKey && <label className="checkbox"><input type="checkbox" checked={removeKey} onChange={e => { setRemoveKey(e.target.checked); resetModels(); }} />Remove the saved API key</label>}</div>
      <label>Model context window<NumberInput required value={(data as Connection).contextWindow} onChange={contextWindow => setData({ ...data as Connection, contextWindow })} /></label><label>Reserved output tokens<NumberInput required max={1_000_000} value={(data as Connection).maxOutputTokens} onChange={maxOutputTokens => setData({ ...data as Connection, maxOutputTokens })} /></label><label className="full">Custom request parameters<textarea className="code-input" value={parameters} onChange={e => setParameters(e.target.value)} /><small>temperature, top_p, presence_penalty, frequency_penalty, seed, stop and reasoning_effort.</small></label>
    </>}
    {initial.kind === 'prompts' && <div className="full"><p className="small muted">Text blocks and card fields support {'{{user}}'} and {'{{char}}'}. Messages keep their stored roles and text. Include exactly one enabled Messages marker. Summary stays empty until compaction is available.</p><PromptEditor value={data as PromptPreset} change={setData} /></div>}
  </div></fieldset>{error && <p role="alert">{error}</p>}{stale && <p role="status">The library changed. Close this editor and reopen it before saving.</p>}<div className="actions"><button disabled={busy || stale}>Save {initial.kind === 'connections' ? 'Connection' : initial.kind.slice(0, -1)}</button><button type="button" className="quiet" onClick={close}>Close editor</button></div></form>;
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
  return <><div className="prompt-blocks" onDragOver={event => {
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
        {block.kind === 'text' ? <label>Block text<textarea value={block.text} onChange={event => update(index, { ...block, text: event.target.value })} /></label> : <label>Marker source<Dropdown aria-label={`Marker source for block ${index + 1}`} value={block.marker} onChange={marker => update(index, { ...block, marker: marker as typeof block.marker })} options={markers.map(marker => ({ value: marker, label: marker === 'summary' ? 'Summary (future compaction)' : marker[0].toUpperCase() + marker.slice(1) }))} /></label>}
      </div>}
    </section>;
  })}</div><div className="actions"><button type="button" className="secondary" disabled={value.blocks.length >= 100} onClick={() => change({ ...value, blocks: [...value.blocks, { id: crypto.randomUUID(), name: 'Text', enabled: true, kind: 'text', role: 'system', text: '' }] })}>Add text block</button><button type="button" className="secondary" disabled={value.blocks.length >= 100} onClick={() => change({ ...value, blocks: [...value.blocks, { id: crypto.randomUUID(), name: 'Marker', enabled: true, kind: 'marker', role: 'system', marker: 'description' }] })}>Add marker</button></div></>;
}
