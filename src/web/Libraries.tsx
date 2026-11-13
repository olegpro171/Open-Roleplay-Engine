import { moveListItem, useListReorder } from './useListReorder';
import { LibraryImport } from './LibraryImport';
import { ActionMenu } from './ActionMenu';
import { LibrarySearchField } from './LibrarySearchField';
import type { MessageText } from './localization';
import { displayLibraryRecord, libraryEditorTitle, newLibraryLabel, searchLibraryLabel, sortLibraryLabel } from './localization-labels';
import { LocalizedError, formatMessage, useTextState, errorText, t, message as msg, useLocale, locale, currentPack } from './localization';
import { libraryLabel, characterFieldLabel, markerLabel as localizedMarkerLabel, stateLabel } from './localization-labels';
import { librarySortSchema, readLibrarySort, sortLibraryItems, sortOptions, type LibrarySort } from './library-sorting';
import { chatGroupId, preferredBranch } from './chat-selection';
import { SpeechColorSelector } from './SpeechColorSelector';
import { newId } from './uuid';
import { Icon } from './Icon';
import { PersonaIcon } from './PersonaIcon';
import { defaultChatInputTarget, type ChatDefaultsStatus, type ChatDefaultKind } from '../shared/chat-defaults';
import type { PromptDiagnostic } from '../shared/prompt-diagnostics';
import { useConfirmation } from './Confirmation';
import { LibraryDeletionDialog, readDeletionRetry, type LibraryDeletionTarget } from './LibraryDeletionDialog';
import { WarningDetails, WarningDialog, WarningMessages } from './WarningDialog';
import { saveMemoryCleanupCopy, useMemoryCleanup } from './MemoryCleanupReview';
import { CharacterAvatar, PictureSquare } from './Pictures';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEventHandler, type ReactNode } from 'react';
import { ChatWorkspace } from './ChatWorkspace';
import type { ChatToolsSnapshot, Connection, ConnectionDiagnostic } from '../shared/contracts';
import { characterLabel, personaLabel, characterFields, defaultPrompt, markers, markerLabel, promptWarningMessages, type ChatSummary, type LibraryCharacter, type LibraryPersona, type LibraryKind, type LibrarySnapshot, type PromptBlock, type PromptPreset, type Saved } from '../shared/library';
import { upgradePrompt } from '../core/prompt-upgrade';
import { ChatParticipants, characterDropdownOptions, personaDropdownOptions, type ChatParticipantsValue } from './ChatParticipants';
import { TranscriptImport } from './TranscriptImport';
import { CharacterImport } from './CharacterImport';
import { ConnectionFileDialog, type ConnectionFileAction } from './ConnectionFileDialog';
import { ModelField } from './ModelPicker';
import { CharacterEditor } from './CharacterEditor';
import { EditorActions, EditorActionsTarget } from './EditorActions';
import { EditorTextarea } from './EditorTextarea';
import { TagChips, TagFilterMenu } from './Tags';
import { characterTagIndex, matchesCharacterTags } from '../shared/tags';
import { api, datasetEpoch } from './api';
import { Dropdown, NumberDraftContext, NumberInput } from './Controls';
import { defaultContextPreset, type ContextPreset } from '../shared/context';
import { newLorebook, type Lorebook, type LoreDiagnostic } from '../shared/lorebook';
import { LorebookEditor, LorebookImport, LoreDiagnostics } from './LorebookEditor';
import { CopyLibraryDraft, LibraryDraftNotice, StaleLibraryDraft, useLibraryEditorDraft, useLibraryNumberDraft, type LeaveLibraryEditor } from './LibraryDraft';
import { sameDraftValue, type LibraryDraft, type LibraryEditorDraft } from './library-draft';

export const defaultConnection: Connection = { name: 'My Connection', endpoint: 'https://api.openai.com/v1', model: '', contextWindow: 128_000, maxOutputTokens: 8196, customParameters: {} };

function newPrompt(): PromptPreset {
  const sourceMarkers = structuredClone(defaultPrompt.blocks.filter(block => block.kind === 'marker'));
  return {
    name: newLibraryLabel('prompts'),
    blocks: [
      { id: 'pre-history-instructions', name: t('libraries.pre_history_instructions'), enabled: true, kind: 'text', role: 'system', text: '' },
      ...sourceMarkers,
      { id: 'post-history-instructions', name: t('libraries.post_history_instructions'), enabled: true, kind: 'text', role: 'system', text: '' },
    ],
  };
}
type Run = (action: () => Promise<unknown>) => Promise<boolean>;
type Selection = { title: string; targetInputTokens: number; connectionId: string | null; promptId: string; characterId: string | null; personaId: string | null; contextPresetId: string | null; lorebookId: string | null };
type LibraryRecord = LibraryCharacter | LibraryPersona | PromptPreset | Connection | ContextPreset | Lorebook;
const libraryLabels: Record<LibraryKind | 'chats', string> = {
  chats: 'Chats',
  personas: 'Personas',
  characters: 'Characters',
  lorebooks: 'Lorebooks',
  prompts: 'Prompts',
  connections: 'Connections',
  contexts: 'Context presets',
};
function lastLibrarySection(): LibraryKind | 'chats' {
  try {
    const value = localStorage.getItem('roleplay-library-section');
    return value && Object.hasOwn(libraryLabels, value) ? value as LibraryKind | 'chats' : 'chats';
  } catch { return 'chats'; }
}
function selection(snapshot: ChatToolsSnapshot): Selection {
  return { title: snapshot.settings.title, targetInputTokens: snapshot.settings.targetInputTokens,
    connectionId: snapshot.settings.connectionId ?? null, promptId: snapshot.settings.promptId ?? 'default',
    characterId: snapshot.settings.characterId ?? null, personaId: snapshot.settings.personaId ?? null, contextPresetId: snapshot.settings.contextPresetId ?? null, lorebookId: snapshot.settings.lorebookId ?? null };
}
function libraryDropdownOptions(library: LibrarySnapshot, kind: Exclude<LibraryKind, 'characters' | 'personas'>) {
  const records: readonly { id: string; name: string }[] = library[kind];
  const sorted = sortLibraryItems(records, readLibrarySort(kind), record => displayLibraryRecord(record).name, record => library.dates[record.id]);
  return [
    ...(kind === 'prompts' ? [] : [{ value: '', label: t('character_editor.none_selected') }]),
    ...sorted.map(record => ({ value: record.id, label: displayLibraryRecord(record).name })),
  ];
}
function SelectionFields({ value, change, library }: { value: Selection; change: (value: Selection) => void; library: LibrarySnapshot }) {
  useLocale();
  const fields = [
    { key: 'connectionId', label: t('libraries.connection'), options: libraryDropdownOptions(library, 'connections') },
    { key: 'promptId', label: t('libraries.prompt_preset'), options: libraryDropdownOptions(library, 'prompts') },
    { key: 'characterId', label: t('app.character'), options: characterDropdownOptions(library) },
    { key: 'personaId', label: t('libraries.persona'), options: personaDropdownOptions(library) },
    { key: 'contextPresetId', label: t('libraries.context_preset'), options: libraryDropdownOptions(library, 'contexts') },
    { key: 'lorebookId', label: t('libraries.lorebook'), options: libraryDropdownOptions(library, 'lorebooks') },
  ] as const;
  return <div className="form-grid">
    <label>{t("libraries.chat_title")}<input required maxLength={100} value={value.title} onChange={e => change({ ...value, title: e.target.value })} /></label>
    <label>{t("libraries.target_input_tokens")}<NumberInput required value={value.targetInputTokens} onChange={targetInputTokens => change({ ...value, targetInputTokens })} /></label>
    {fields.map(({ key, label, options }) => <label key={key}>{label}
      <Dropdown aria-label={label} value={value[key] ?? ''} onChange={selected => change({ ...value, [key]: selected || null })} options={options} />
    </label>)}
  </div>;
}
function NewChat({ library, busy, run, created, cancel }: { library: LibrarySnapshot; busy: boolean; run: Run; created: (id: string) => void; cancel: () => void }) {
  useLocale();
  const [participants, setParticipants] = useState<ChatParticipantsValue>({ characterId: null, personaId: null });
  const submitting = useRef(false);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || submitting.current) return;
    submitting.current = true;
    try {
      const character = library.characters.find(item => item.id === participants.characterId);
      const title = character ? character.name.slice(0, 100) : t("libraries.a_new_story");
      const settings = { title, targetInputTokens: defaultChatInputTarget, ...participants };
      let id = '';
      if (await run(async () => { id = (await api<{ id: string }>('/chats', 'POST', settings)).id; })) created(id);
    } finally {
      submitting.current = false;
    }
  }
  return <form onSubmit={create}><fieldset disabled={busy}><legend>{t("libraries.new_chat")}</legend>
    <ChatParticipants library={library} value={participants} change={setParticipants} disabled={busy} />
    <div className="actions"><button>{t("libraries.create_chat")}</button><button type="button" className="quiet" onClick={cancel}>{t("character_import.cancel")}</button></div>
  </fieldset></form>;
}
export function ChatSetup({ snapshot, library, busy, run, saved, sidebar, returnToChat, openLibraryItem }: { snapshot: ChatToolsSnapshot; library: LibrarySnapshot; busy: boolean; run: Run; saved: () => void; sidebar: ReactNode; returnToChat: () => void; openLibraryItem: (target: LibraryTarget) => void }) {
  useLocale();
  const [value, setValue] = useState(() => selection(snapshot));
  const [revision] = useState(snapshot.revision);
  const confirmAction = useConfirmation(snapshot.id);
  const reviewMemoryCleanup = useMemoryCleanup(run, snapshot.id);
  const [diagnosticsRetry, setDiagnosticsRetry] = useState(0);
  const diagnosticsKey = JSON.stringify([snapshot.id, snapshot.revision, library.revision, value.promptId, value.characterId, value.personaId, value.lorebookId, diagnosticsRetry]);
  const [diagnostics, setDiagnostics] = useState<{ key: string; warnings: PromptDiagnostic[]; error?: MessageText } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api<PromptDiagnostic[]>(`/chats/${snapshot.id}/prompt-diagnostics`, 'POST', { revision: snapshot.revision, settings: { ...selection(snapshot), promptId: value.promptId, characterId: value.characterId, personaId: value.personaId, lorebookId: value.lorebookId } }, controller.signal).then(warnings => {
      if (!controller.signal.aborted) setDiagnostics({ key: diagnosticsKey, warnings });
    }).catch(error => {
      if (!controller.signal.aborted) setDiagnostics({ key: diagnosticsKey, warnings: [], error: errorText(error, msg("libraries.could_not_check_prompt_configuration")) });
    });
    return () => controller.abort();
  }, [snapshot.id, snapshot.revision, diagnosticsKey]);
  function openWarning(warning: PromptDiagnostic) {
    const target = { kind: warning.target, id: warning.itemId };
    if (JSON.stringify(value) === JSON.stringify(selection(snapshot))) openLibraryItem(target);
    else confirmAction({ title: t("libraries.discard_chat_settings_changes"), message: t("libraries.open_the_library_editor_and_discard_unsaved"), actionLabel: t("libraries.discard_changes"), onConfirm: () => openLibraryItem(target) });
  }
  const formId = useId();
  const mounted = useRef(true);
  const submitting = useRef(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return <ChatWorkspace sidebar={sidebar} returnToChat={saving ? undefined : returnToChat} actions={<>
    <button type="submit" form={formId} disabled={busy || revision !== snapshot.revision} aria-label={t("libraries.save_and_return")} title={t("libraries.save_and_return")}><Icon name="SaveOutline" /><span>{t("libraries.save_and_return")}</span></button>
    <button type="button" className="secondary" disabled={saving} onClick={returnToChat} aria-label={t("libraries.return_without_saving")} title={t("libraries.return_without_saving")}><Icon name="Close" /><span>{t("libraries.return_without_saving")}</span></button>
  </>}><section className="document-panel chat-panel" aria-label={t("app.chat_settings")}><p className="eyebrow">{t("libraries.chat_settings")}</p><h1>{t("libraries.choose_this_story_s_ingredients")}</h1><p className="muted">{t("libraries.each_chat_keeps_its_own_selections_edit")}</p>
    <form id={formId} onSubmit={async e => {
      e.preventDefault();
      if (busy || submitting.current || revision !== snapshot.revision) return;
      submitting.current = true;
      setSaving(true);
      try {
        const commit = (memoryImpactToken?: string) => api(`/chats/${snapshot.id}/selections`, 'PUT', { revision, settings: value, memoryImpactToken });
        if (value.contextPresetId !== (snapshot.settings.contextPresetId ?? null)) {
          await reviewMemoryCleanup({
            path: `/chats/${snapshot.id}/settings/memory-impact`, body: { revision, contextPresetId: value.contextPresetId },
            copy: saveMemoryCleanupCopy(), commit, saved,
          });
        } else if (await run(() => commit()) && mounted.current) saved();
      } finally { submitting.current = false; if (mounted.current) setSaving(false); }
    }}><fieldset disabled={busy}><legend>{t("libraries.selections")}</legend><SelectionFields value={value} change={setValue} library={library} /></fieldset>
      {revision !== snapshot.revision && <p role="status">{t("libraries.this_chat_changed_reopen_chat_settings_to")}</p>}
    </form>
    {diagnostics?.key !== diagnosticsKey || diagnostics.error ? <section className="import-panel" aria-label={t("libraries.prompt_configuration_warnings")}>
      <h2>{t("libraries.prompt_configuration_warnings")}</h2>
      {diagnostics?.key !== diagnosticsKey ? <p role="status">{t("libraries.checking_prompt_configuration")}</p> : <>
        <p role="alert">{formatMessage(diagnostics.error)}</p>
        <button type="button" className="secondary" onClick={() => setDiagnosticsRetry(value => value + 1)}>{t("libraries.check_again")}</button>
      </>}
    </section> : diagnostics.warnings.length > 0 && <WarningDetails key={diagnosticsKey} label={t("libraries.prompt_configuration_warnings")}
      title={t("libraries.prompt_configuration_warnings")}>{close => (
        <ul className="warning-messages">{diagnostics.warnings.map(warning => <li key={warning.code}>
          <p>{formatMessage(warning.localized ?? warning.message)}</p>
          <button type="button" className="secondary" onClick={() => { close(); openWarning(warning); }}>
            <Icon name="EditOutline" />{t("libraries.edit", { value: warning.target === 'prompts' ? t("interface.prompt_preset") : warning.target === 'characters' ? t("app.character") : t("libraries.lorebook") })}
          </button>
        </li>)}</ul>
      )}</WarningDetails>}
  </section></ChatWorkspace>;
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
  if ('titleComment' in record && record.titleComment && matches(record.titleComment)) return true;
  if ('description' in record && matches(record.description)) return true;
  if ('model' in record && matches(record.model)) return true;
  return 'entries' in record && record.entries.some(entry => matches(entry.name) || matches(entry.comment) || matches(entry.content) || entry.keys.some(matches) || entry.secondaryKeys.some(matches));
}
function LibrarySearch({ section, value, change, sort, changeSort, children }: { section: LibraryKind | 'chats'; value: string; change: (value: string) => void; sort: LibrarySort; changeSort: (value: string) => void; children?: ReactNode }) {
  useLocale();
  return <div className="library-browse-controls">
    <LibrarySearchField label={searchLibraryLabel(section)} value={value} change={change} />
    {children}<div className="library-sort"><Dropdown aria-label={sortLibraryLabel(section)} value={sort} onChange={changeSort} options={sortOptions(section)} /></div>
  </div>;
}
const libraryIcons: Record<LibraryKind | 'chats', ReactNode> = {
  chats: <Icon name="ChatOutline" />,
  personas: <PersonaIcon />,
  characters: <Icon name="Profile" />,
  lorebooks: <Icon name="FolderOutline" />,
  prompts: <Icon name="TextbookOutline" />,
  connections: <Icon name="Link" />,
  contexts: <Icon name="FilterOutline" />,
};

function LibraryIcon({ kind }: { kind: LibraryKind | 'chats' }) {
  return libraryIcons[kind];
}

function LibraryHeader({ editing, children }: { editing: boolean; children: ReactNode }) {
  const header = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = header.current;
    const panel = element?.parentElement;
    const workspace = panel?.parentElement;
    if (!element || !panel || !workspace) return;
    // Native keyboard/scroll-into-view navigation must leave focused actions
    // below the sticky controls, including translated or wrapped toolbar text.
    const measure = () => {
      const padding = getComputedStyle(element).position === 'sticky' ? `${element.offsetHeight + 12}px` : '';
      panel.style.scrollPaddingBlockStart = padding;
      workspace.style.scrollPaddingBlockStart = padding;
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      panel.style.scrollPaddingBlockStart = '';
      workspace.style.scrollPaddingBlockStart = '';
    };
  }, [editing]);
  return <header ref={header} className={`library-list-header${editing ? ' is-editing' : ''}`}>{children}</header>;
}

export type LibraryTarget = { kind: 'prompts' | 'characters' | 'lorebooks' | 'contexts'; id: string };
type LibraryEditing = { kind: LibraryKind; id?: string; revision: number; data: LibraryRecord; hasApiKey?: boolean };

function savedEditor(library: LibrarySnapshot, kind: LibraryKind, id: string): LibraryEditing | null {
  const record = library[kind].find(record => record.id === id);
  if (!record) return null;
  const { id: _id, revision: _revision, hasApiKey, ...data } = { ...record, hasApiKey: 'hasApiKey' in record && record.hasApiKey };
  return { kind, id, revision: library.revision, data, hasApiKey };
}

function newEditor(kind: LibraryKind, revision: number): LibraryEditing {
  const data = kind === 'lorebooks' ? newLorebook() : kind === 'connections' ? defaultConnection : kind === 'contexts' ? { ...structuredClone(defaultContextPreset), name: newLibraryLabel('contexts') } : kind === 'prompts' ? newPrompt() : kind === 'personas' ? { name: '', titleComment: '', description: '' } : { name: '', titleComment: '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', lorebookId: null };
  return { kind, revision, data };
}

export function Libraries({ library, defaults, currentBranchId, branchSelections, busy, run, openChat, initialTarget, recoveredDraft, leaveEditor, clearDraft }: { library: LibrarySnapshot; defaults: ChatDefaultsStatus; currentBranchId: string | null; branchSelections: ReadonlyMap<string, string>; busy: boolean; run: Run; openChat: (id: string, destination?: 'story' | 'settings') => void; initialTarget?: LibraryTarget | null; recoveredDraft: LibraryDraft | null; leaveEditor: LeaveLibraryEditor; clearDraft: () => void }) {
  useLocale();
  const [recovery, setRecovery] = useState(recoveredDraft);
  const [section, setSection] = useState<LibraryKind | 'chats'>(recovery?.editor.kind ?? initialTarget?.kind ?? lastLibrarySection);
  useEffect(() => {
    try { localStorage.setItem('roleplay-library-section', section); }
    catch { /* Navigation still works when browser storage is unavailable. */ }
  }, [section]);
  const [sorts, setSorts] = useState(() => ({
    chats: readLibrarySort('chats'), personas: readLibrarySort('personas'), characters: readLibrarySort('characters'),
    lorebooks: readLibrarySort('lorebooks'), prompts: readLibrarySort('prompts'), connections: readLibrarySort('connections'), contexts: readLibrarySort('contexts'),
  }));
  const sort = sorts[section];
  function changeSort(value: string) {
    const result = librarySortSchema.safeParse(value);
    if (!result.success || !sortOptions(section).some(option => option.value === result.data)) return;
    setSorts(previous => ({ ...previous, [section]: result.data }));
    try { localStorage.setItem(`roleplay-library-sort-${section}`, result.data); }
    catch { /* Keep the current choice for this visit if storage is unavailable. */ }
  }
  const confirmAction = useConfirmation(section);
  const [editing, setEditing] = useState<LibraryEditing | null>(() => {
    if (recovery) {
      const { kind, id, revision } = recovery.editor;
      if (recovery.epoch !== datasetEpoch() || revision !== library.revision) return null;
      return id ? savedEditor(library, kind, id) : newEditor(kind, revision);
    }
    return initialTarget ? savedEditor(library, initialTarget.kind, initialTarget.id) : null;
  });
  const staleRecovery = !editing && recovery;
  const editorOpen = Boolean(editing || staleRecovery);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  function closeEditor() {
    if (!mounted.current) return;
    clearDraft();
    setRecovery(null);
    setEditing(null);
  }
  const cancelEditor: MouseEventHandler<HTMLButtonElement> = event => leaveEditor(closeEditor, { returnFocus: event.currentTarget });
  const reviewMemoryCleanup = useMemoryCleanup(run, `${section}:${editing?.id ?? editing?.kind ?? ''}`);
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const wasEditing = useRef(Boolean(editing));
  useLayoutEffect(() => {
    let frame = 0;
    let restoreOverflow: (() => void) | undefined;
    if (wasEditing.current && !editing && panel.current) {
      const content = panel.current;
      // Phones scroll the categories and content together, rather than the
      // overflow:visible panel. Reset the element that actually owns scrolling.
      const scroller = getComputedStyle(content).overflowY === 'visible' ? content.parentElement : content;
      if (scroller) {
        const overflow = scroller.style.overflow;
        restoreOverflow = () => { scroller.style.overflow = overflow; };
        // Keep the scrolling box removed for a rendered frame so compositor
        // momentum ends before scrolling is enabled again. Keep children mounted
        // to preserve search state and pending import reviews.
        scroller.style.overflow = 'clip';
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => {
            scroller.style.overflow = overflow;
            scroller.scrollTo({ left: 0, top: 0, behavior: 'instant' });
          });
        });
      }
    }
    wasEditing.current = Boolean(editing);
    return () => {
      cancelAnimationFrame(frame);
      restoreOverflow?.();
    };
  }, [editing]);
  const [creatingChat, setCreatingChat] = useState(false);
  const [deletion, setDeletion] = useState<LibraryDeletionTarget | null>(() => readDeletionRetry()?.target ?? null);
  const [connectionFile, setConnectionFile] = useState<ConnectionFileAction | null>(null);
  const [notice, setNotice] = useTextState(''), [diagnostics, setDiagnostics] = useState<LoreDiagnostic[]>([]), [search, setSearch] = useState('');
  const [warning, setWarning] = useState<{ message: MessageText; returnFocus?: HTMLElement | null } | null>(null);
  const presetImportTrigger = useRef<HTMLButtonElement>(null);
  const [pendingBook, setPendingBook] = useState<string | null>(null);
  const [filters, setFilters] = useState<string[]>([]);
  const pictureIndex = useMemo(() => new Map(library.characterPictures.map(picture => [picture.characterId, picture])), [library.characterPictures]);
  const tagCatalog = useMemo(() => new Map(library.tags.map(tag => [tag.id, tag])), [library.tags]);
  const tagIndex = useMemo(() => characterTagIndex(library.characterTags), [library.characterTags]);
  useEffect(() => { const ids = new Set(library.tags.map(tag => tag.id)); setFilters(previous => previous.filter(id => ids.has(id))); }, [library.tags]);
  const query = search.normalize('NFC').toLowerCase();
  const visibleChats = useMemo(() => {
    const groups = new Map<string, ChatSummary[]>();
    for (const branch of library.chats) {
      const id = chatGroupId(branch);
      const siblings = groups.get(id);
      if (siblings) siblings.push(branch);
      else groups.set(id, [branch]);
    }
    const cards = [];
    for (const [id, branches] of groups) {
      const branch = preferredBranch(branches, branchSelections.get(id));
      if (!branch || !matchesSearch(branch.title, query)) continue;
      const lastMessageAt = branches.reduce<string | null>((latest, item) =>
        item.lastMessageAt && (!latest || item.lastMessageAt > latest) ? item.lastMessageAt : latest, null);
      cards.push({ id, branch, branches, lastMessageAt, running: branches.some(item => item.running) });
    }
    return sortLibraryItems(cards, sort, card => card.branch.title, card => ({
      createdAt: card.branch.createdAt, updatedAt: card.branch.updatedAt, lastMessageAt: card.lastMessageAt,
    }));
  }, [library.chats, branchSelections, query, sort]);
  const displayLanguage = currentPack();
  const visibleRecords = useMemo<Saved<LibraryRecord>[]>(() => {
    if (section === 'chats') return [];
    return sortLibraryItems(library[section].filter(record => matchesLibraryRecord(displayLibraryRecord(record), query)
      && (section !== 'characters' || matchesCharacterTags(tagIndex.get(record.id), filters))), sort, record => characterLabel(displayLibraryRecord(record)), record => library.dates[record.id]);
  }, [section, library, query, tagIndex, filters, sort, displayLanguage]);
  useEffect(() => {
    if (!pendingBook) return;
    const book = library.lorebooks.find(item => item.id === pendingBook);
    if (!book) return;
    const { id, revision: _revision, ...data } = book;
    setFilters([]); setSearch(''); setSection('lorebooks'); setEditing({ kind: 'lorebooks', id, revision: library.revision, data }); setPendingBook(null);
  }, [pendingBook, library]);
  function openBook(id: string, returnFocus: HTMLElement) {
    const book = savedEditor(library, 'lorebooks', id);
    if (!book) { setWarning({ message: msg("libraries.the_lorebook_is_not_yet_loaded_reopen") }); return; }
    leaveEditor(() => {
      setRecovery(null);
      setFilters([]);
      setSearch('');
      setSection('lorebooks');
      setEditing(book);
    }, { returnFocus });
  }
  function create() {
    if (section !== 'chats') setEditing(newEditor(section, library.revision));
  }
  function renderEditor(initial: LibraryEditing) {
    const recovered = recovery?.editor;
    if (initial.kind === 'characters' && 'personality' in initial.data) {
      return <CharacterEditor key={initial.id ?? 'new-character'} initial={{ ...initial, data: initial.data }}
        recovered={recovered?.kind === 'characters' ? recovered : undefined} library={library} busy={busy} run={run}
        close={cancelEditor} closeAfterSave={closeEditor} openBook={openBook}
        saved={() => setNotice(msg("libraries.character_saved", { value: filters.length ? t("interface.it_may_be_hidden_by_your_tag_filters") : '' }))}
        extracted={id => {
          closeEditor();
          setFilters([]);
          setSection('lorebooks');
          setNotice(msg("libraries.embedded_lorebook_extracted_review_its_shared_library"));
          setPendingBook(id);
        }} />;
    }
    if (initial.kind === 'lorebooks' && 'entries' in initial.data) {
      return <LorebookEditor key={initial.id ?? 'new-lorebook'} initial={{ ...initial, data: initial.data }}
        recovered={recovered?.kind === 'lorebooks' ? recovered : undefined} currentRevision={library.revision}
        busy={busy} run={run} close={cancelEditor} committed={closeEditor} />;
    }
    if ('personality' in initial.data || 'entries' in initial.data) return null;
    const restored = recovered?.kind !== 'characters' && recovered?.kind !== 'lorebooks' ? recovered : undefined;
    return <LibraryEditor key={initial.id ?? initial.kind} initial={{ ...initial, data: initial.data }} recovered={restored}
      connections={library.connections} currentRevision={library.revision} busy={busy} run={run}
      close={cancelEditor} committed={closeEditor} />;
  }
  async function duplicate(item: Saved<LibraryRecord>) {
    if (section === 'chats') return;
    if (section === 'characters' || section === 'connections') {
      await api(`/library/${section}/${item.id}/duplicate`, 'POST', { revision: library.revision });
    } else {
      const { id: _id, revision: _revision, ...data } = item;
      await api('/library', 'POST', { kind: section, revision: library.revision, data: {
        ...data, name: `${item.name.slice(0, 90)} copy`,
        ...('entries' in data ? { entries: data.entries.map(entry => ({ ...entry, id: newId() })) } : {}),
      } });
    }
    if (section === 'connections') {
      setNotice('');
      setWarning({ message: msg("libraries.connection_copied_add_its_api_key_in") });
    } else {
      setNotice(section === 'characters' && 'lorebookId' in item && item.lorebookId ? msg("libraries.character_copied_its_default_lorebook_is_shared")
        : section === 'lorebooks' ? msg("libraries.independent_lorebook_copy_saved") : msg("libraries.copy_saved"));
    }
  }
  return <EditorActionsTarget.Provider value={actionsTarget}><div className="library-workspace"><main className="library-layout">
    <aside className="library-sidebar">
      <div className="library-navigation">
      <p className="eyebrow">{t("libraries.your_libraries")}</p>
      <nav className="library-tabs" aria-label={t("libraries.library_categories")}>
        {(['chats', 'personas', 'characters', 'lorebooks', 'prompts', 'connections', 'contexts'] as const).map(kind => <button
          type="button"
          aria-pressed={section === kind}
          key={kind}
          disabled={busy && editorOpen}
          onClick={event => leaveEditor(() => {
            if (kind !== 'characters') setFilters([]);
            setSection(kind);
            closeEditor();
            setCreatingChat(false);
            setNotice('');
            setDiagnostics([]);
            setSearch('');
          }, { returnFocus: event.currentTarget })}
        ><LibraryIcon kind={kind} />{libraryLabel(kind)}</button>)}
      </nav>
      </div>
      <div className="library-editor-target" ref={setActionsTarget} />
    </aside>
    <section ref={panel} key={section} className="document-panel library-panel" aria-labelledby="library-heading">
    <LibraryHeader editing={editorOpen || creatingChat}>
      <h1 id="library-heading">{libraryLabel(section)}</h1>
      {section === 'chats' && <div className="actions library-toolbar" role="group" aria-label={t("character_import.library_actions")}><button disabled={busy || creatingChat} onClick={() => setCreatingChat(true)}><Icon name="AddToList" />{t("libraries.new_chat")}</button>
        <TranscriptImport destination={{ kind: 'chat', library }} disabled={busy || creatingChat} created={id => openChat(id, 'settings')} />
      </div>}
      {!editorOpen && section !== 'chats' && section !== 'characters' && section !== 'lorebooks' && <div className="actions library-toolbar" role="group" aria-label={t("character_import.library_actions")}><button disabled={busy} onClick={create}><Icon name="AddToList" />{newLibraryLabel(section)}</button>
        {section === 'connections' && <LibraryImport label={t('connection_files.import_button')} description={t('library_import.connection_description')} accept=".oreconnection,application/octet-stream" disabled={busy} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file) setConnectionFile({ kind: 'import', file, revision: library.revision });
        }} />}
        {(section === 'personas') && <LibraryImport label={t("libraries.import_personas")} description={t('library_import.persona_description')} accept=".json" disabled={busy} onChange={async e => {
          const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
          await run(async () => {
            if (file.size > 2_000_000) throw new LocalizedError(msg("libraries.card_imports_are_limited_to_2_mb"));
            const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
            const result = await api<{ ids: string[]; books?: { id: string; name: string; entries: number }[]; diagnostics?: LoreDiagnostic[] }>('/library/import', 'POST', { revision: library.revision, requestId: newId(), kind: section, base64: btoa(binary) });
            setNotice(msg("libraries.imported_persona_s", { length: result.ids.length, value: result.books?.map(book => t("interface.lorebook_entries", { name: String(book.name), entries: String(book.entries) })).join('') ?? '' })); setDiagnostics(result.diagnostics ?? []);
          });
        }} />}
        {(section === 'prompts' || section === 'contexts') && <LibraryImport
          label={t("libraries.import", { value: section === 'contexts' ? t("interface.context_preset") : t("interface.prompt_preset") })}
          description={t(section === 'contexts' ? 'library_import.context_description' : 'library_import.prompt_description')}
          accept=".json" disabled={busy} triggerRef={presetImportTrigger} onChange={async event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            setNotice('');
            const returnFocus = presetImportTrigger.current;
            let usedChatConnection = false;
            const saved = await run(async () => {
              if (file.size > 1_000_000) throw new LocalizedError(msg("libraries.preset_file_is_too_large"));
              const value: unknown = JSON.parse(await file.text());
              if (section === 'prompts') {
                await api('/library', 'POST', { kind: section, revision: library.revision, data: upgradePrompt(value) });
              } else {
                const result = await api<{ usedChatConnection: boolean }>('/library/contexts/import', 'POST', { revision: library.revision, data: value });
                usedChatConnection = result.usedChatConnection;
              }
            });
            if (saved && usedChatConnection) setWarning({ message: msg('library_import.context_connection_missing'), returnFocus });
          }} />}
      </div>}
      {!editorOpen && section === 'lorebooks' && <LorebookImport leadingAction={<button disabled={busy} onClick={create}><Icon name="AddToList" />{t("libraries.new_lorebook")}</button>} revision={library.revision} busy={busy} run={run} imported={(_id, message) => setNotice(message)} />}
      {section === 'characters' && <CharacterImport hidden={editorOpen} leadingAction={<button disabled={busy} onClick={create}><Icon name="AddToList" />{t("libraries.new_character")}</button>} revision={library.revision} busy={busy} run={run} imported={(result, missing) => {
        setNotice('');
        if (missing) setWarning({ message: msg("libraries.the_original_import_was_saved_but_its") });
        setDiagnostics(result.diagnostics);
      }} />}
      {!editorOpen && !creatingChat && <LibrarySearch section={section} value={search} change={setSearch} sort={sort} changeSort={changeSort}>
        {section === 'characters' && <TagFilterMenu library={library} busy={busy} run={run} selected={filters} change={setFilters} />}
      </LibrarySearch>}
    </LibraryHeader>
    {notice && <p className="library-notice" role="status">{notice}</p>}<LoreDiagnostics diagnostics={diagnostics} />
    {warning && <WarningDialog {...warning} close={() => setWarning(null)} />}
    {section === 'chats' ? <>
      {creatingChat && <NewChat library={library} busy={busy} run={run} created={id => { setCreatingChat(false); openChat(id, 'settings'); }} cancel={() => setCreatingChat(false)} />}
      <div className="library-list chat-list">
        {visibleChats.map(({ id, branch, branches, running }) => <article key={id} className="chat-card">
          <div className="chat-card-details">
            <CharacterAvatar url={branch.characterId ? pictureIndex.get(branch.characterId)?.thumbnailUrl : undefined} />
            <div className="chat-card-text">
              <h2><button type="button" className="chat-card-open" onClick={() => openChat(branch.id)}>{branch.title}</button></h2>
              <p>{t("libraries.turns", { turnCount: branch.turnCount, value: running ? t("interface.response_running") : '', value2: currentBranchId === branch.id ? t("interface.current_chat") : '' })}</p>
            </div>
          </div>
          <button type="button" className="quiet chat-card-delete" disabled={busy || running} onClick={() => {
            confirmAction({ confirmOnEnter: true, title: t("libraries.delete_chat"),
              message: t(branches.length > 1 ? 'branches.delete_chat' : 'libraries.delete_and_all_its_turns_and_requests', { title: branch.title }),
              actionLabel: t("libraries.delete_chat_2"),
              onConfirm: () => { void run(() => api(`/chats/${branch.id}`, 'DELETE', {
                revision: branch.revision, branches: branches.map(({ id, revision }) => ({ id, revision })),
              })); } });
          }}><Icon name="TrashOutline" />{t("libraries.delete_chat_2")}</button>
        </article>)}
        {library.chats.length === 0 && <p className="muted">{t("libraries.create_a_chat_to_start_your_next")}</p>}
        {query && visibleChats.length === 0 && library.chats.length > 0 && <p className="muted" role="status">{t("libraries.no_chats_match_your_search")}</p>}
      </div>
    </> : <>
      {staleRecovery ? <StaleLibraryDraft draft={staleRecovery} close={cancelEditor} /> : editing ? renderEditor(editing) : <>
      {section === 'characters' && filters.length > 0 && <div className="character-active-filters" aria-label={t("libraries.active_tag_filters")} role="group">
        <TagChips tags={library.tags} catalog={tagCatalog} selected={filters} remove={id => setFilters(filters.filter(value => value !== id))} />
        <button type="button" className="quiet" onClick={() => setFilters([])}>{t("libraries.clear_filters")}</button>
        <span className="small muted" role="status">{t("libraries.of_characters", { length: visibleRecords.length, length2: library.characters.length })}</span>
      </div>}
      <div className={`library-list${section === 'characters' ? ' character-list' : ''}`}>
        {visibleRecords.map(item => <article className="library-card" key={item.id}>
          <div className="library-card-body">
            {section === 'characters' && <PictureSquare url={pictureIndex.get(item.id)?.thumbnailUrl} />}
            <div className="library-card-content">
              <div className="library-card-heading">
                <h2 title={characterLabel(displayLibraryRecord(item))}>
                  <button type="button" className="library-card-open" disabled={busy} onClick={() => {
                    setEditing(savedEditor(library, section, item.id));
                  }}><span className="library-card-title">{displayLibraryRecord(item).name}
                  {(section === 'characters' || section === 'personas') && 'titleComment' in item && item.titleComment && <span className="character-comment"> · {item.titleComment}</span>}</span></button>
                </h2>
                <div className="library-card-tools">
                  {(section === 'prompts' || section === 'connections' || section === 'contexts') && <DefaultBookmark kind={section} item={item} defaults={defaults} libraryRevision={library.revision} busy={busy} run={run} />}
                  <ActionMenu label={t('libraries.actions_for', { name: characterLabel(item) })} disabled={busy} revision={library.revision}>
                    <button className="secondary" role="menuitem" tabIndex={-1} aria-label={section === 'characters' ? t("libraries.duplicate", { value: characterLabel(item) }) : undefined} disabled={busy} onClick={() => void run(() => duplicate(item))}><Icon name="CopyOutline" />{t("libraries.duplicate_2")}</button>
                    {section === 'connections' ? <button type="button" className="secondary" role="menuitem" tabIndex={-1} disabled={busy} aria-haspopup="dialog" onClick={() => {
                      setConnectionFile({ kind: 'export', id: item.id, name: item.name });
                    }}><Icon name="Upload" />{t('connection_files.export_button')}</button> : <button className="secondary" role="menuitem" tabIndex={-1} aria-label={section === 'characters' ? t("libraries.export_json", { value: characterLabel(item) }) : undefined} onClick={() => void run(async () => download(await api(`/library/${section}/${item.id}/export`), `${item.name.replace(/[^a-z0-9_-]/gi, '_')}.json`))}><Icon name="Upload" />{section === 'characters' ? t("libraries.export_json_2") : t("libraries.export")}</button>}
                    {section === 'prompts' && item.id === 'default' && <button className="secondary" role="menuitem" tabIndex={-1} disabled={busy} onClick={() => { confirmAction({ title: t("libraries.restore_original_prompt"), message: t("libraries.restore_the_built_in_default_prompt_chats"), actionLabel: t("libraries.restore_original"), onConfirm: () => { void run(() => api('/library/default/restore', 'POST', { revision: library.revision })); } }); }}><Icon name="TrashOutline" />{t("libraries.restore_original")}</button>}
                    {section === 'contexts' && item.id === 'default-context' && <button className="secondary" role="menuitem" tabIndex={-1} disabled={busy} onClick={() => {
                      const revision = library.revision;
                      void reviewMemoryCleanup({
                        path: '/library/contexts/default-context/impact', body: { revision, data: defaultContextPreset }, alwaysConfirm: true,
                        copy: { title: msg('libraries.reset_context'), message: msg('libraries.reset_context_confirmation'), actionLabel: msg('libraries.reset') },
                        commit: memoryImpactToken => api('/library/default-context/reset', 'POST', { revision, memoryImpactToken }),
                      });
                    }}><Icon name="TrashOutline" />{t("libraries.reset")}</button>}
                    {!(section === 'prompts' && item.id === 'default') && !(section === 'contexts' && item.id === 'default-context') &&
                      <button type="button" className="secondary" role="menuitem" tabIndex={-1}
                        aria-label={section === 'characters' ? t('libraries.delete', { value: characterLabel(item) }) : undefined}
                        aria-haspopup="dialog" disabled={busy} onClick={() => setDeletion({ kind: section, id: item.id })}>
                        <Icon name="TrashOutline" />{t('libraries.delete_2')}
                      </button>}
                  </ActionMenu>
                </div>
              </div>
              <LibraryDescription text={section === 'connections' && 'model' in item ? item.model
                  : section === 'prompts' && 'blocks' in item ? t("libraries.block_count", { count: item.blocks.length })
                  : section === 'contexts' && 'minTail' in item ? t("libraries.minimum_tail_batch", { minTail: item.minTail, batchSize: item.batchSize })
                  : 'description' in item ? item.description : ''}>
                {section === 'lorebooks' && 'entries' in item &&
                  <p>{t("libraries.entries_enabled", { length: item.entries.length, length2: item.entries.filter(entry => entry.enabled).length })}</p>}
              </LibraryDescription>
            </div>
          </div>
      </article>)}{library[section].length === 0 && <p className="muted">{t("libraries.create_or_import_your_first", { value: libraryLabel(section) })}</p>}{section !== 'characters' && query && visibleRecords.length === 0 && library[section].length > 0 && <p className="muted" role="status">{t("libraries.no_match_your_search", { value: libraryLabel(section).toLowerCase() })}</p>}</div>
      {section === 'characters' && library.characters.length > 0 && visibleRecords.length === 0 && <p role="status">{query ? filters.length ? t("libraries.no_characters_match_your_search_and_selected") : t("libraries.no_characters_match_your_search") : t("libraries.no_characters_match_all_selected_tags_clear")}</p>}
      </>}
    </>}
    </section>
  </main>{deletion && <LibraryDeletionDialog target={deletion}
    name={library[deletion.kind].find(item => item.id === deletion.id)?.name}
    busy={busy} run={run} cancel={() => setDeletion(null)} complete={() => {
      setDeletion(null);
      setNotice(msg('library_delete.success'));
    }} />}{connectionFile && <ConnectionFileDialog action={connectionFile} cancel={() => setConnectionFile(null)} complete={kind => {
    setConnectionFile(null);
    setNotice(kind === 'import' ? msg('connection_files.imported') : '');
    if (kind === 'import') void run(async () => {});
  }} />}</div></EditorActionsTarget.Provider>;
}
function LibraryDescription({ text, children }: { text: string; children?: ReactNode }) {
  useLocale();
  const node = useRef<HTMLDivElement>(null), [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = node.current; if (!element) return;
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1);
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [text, children]);
  return <div ref={node} className={`library-card-description${overflow ? ' overflows' : ''}`}><p>{text}</p>{children}</div>;
}
function DefaultBookmark({ kind, item, defaults, libraryRevision, busy, run }: {
  kind: ChatDefaultKind; item: { id: string; name: string }; defaults: ChatDefaultsStatus;
  libraryRevision: number; busy: boolean; run: Run;
}) {
  useLocale();
  const selected = defaults.settings[kind] === item.id;
  const label = t(selected ? 'libraries.clear_default' : 'libraries.set_default', { name: item.name });
  return <button type="button" className="quiet library-default" aria-label={label} title={label} aria-pressed={selected} disabled={busy}
    onClick={() => void run(() => api('/application/chat-defaults', 'PUT', {
      revision: defaults.revision, libraryRevision, kind, id: selected ? null : item.id,
    }))}><Icon name={selected ? 'Bookmark' : 'BookmarkOutline'} /></button>;
}

type StandardDraft = Exclude<LibraryEditorDraft, { kind: 'characters' | 'lorebooks' }>;

function comparableLibraryFields(data: StandardDraft['data']) {
  if ('description' in data) return { ...data, titleComment: data.titleComment ?? '', speechColor: data.speechColor ?? null };
  if ('endpoint' in data) return { ...data, requestUsage: data.requestUsage !== false };
  return data;
}

function LibraryEditor({ initial, recovered, connections, currentRevision, busy, run, close, committed }: { initial: LibraryEditing & { data: StandardDraft['data'] }; recovered?: StandardDraft; connections: Saved<Connection>[]; currentRevision: number; busy: boolean; run: Run; close: MouseEventHandler<HTMLButtonElement>; committed: () => void }) {
  useLocale();
  const formId = useId();
  const [data, setData] = useState(recovered?.data ?? initial.data);
  const [key, setKey] = useState('');
  const [removeKey, setRemoveKey] = useState(recovered?.kind === 'connections' && recovered.removeKey);
  const [baselineParameters] = useState(() => 'customParameters' in initial.data ? JSON.stringify(initial.data.customParameters, null, 2) : '');
  const [parameters, setParameters] = useState(recovered?.kind === 'connections' ? recovered.parameters : baselineParameters);
  const numberDraft = useLibraryNumberDraft(recovered);
  const keyOmitted = !removeKey && key !== '';
  const draft = useMemo<StandardDraft>(() => {
    const target = { id: initial.id, revision: initial.revision, numbers: numberDraft.values };
    if ('endpoint' in data) return { ...target, kind: 'connections', data, parameters, removeKey, keyOmitted };
    if ('blocks' in data) return { ...target, kind: 'prompts', data };
    if ('batchSize' in data) return { ...target, kind: 'contexts', data };
    return { ...target, kind: 'personas', data };
  }, [initial.id, initial.revision, data, parameters, removeKey, keyOmitted, numberDraft.values]);
  const dataChanged = useMemo(() => data !== initial.data && !sameDraftValue(comparableLibraryFields(data), comparableLibraryFields(initial.data)), [data, initial.data]);
  const dirty = dataChanged || parameters !== baselineParameters || removeKey || key !== '' || numberDraft.dirty;
  const storageError = useLibraryEditorDraft(draft, dirty);
  const [error, setError] = useTextState('');
  const stale = initial.revision !== currentRevision;
  const reviewMemoryCleanup = useMemoryCleanup(run, initial.id);
  async function save(e: FormEvent) {
    e.preventDefault(); setError('');
    if (initial.kind === 'connections' && !(data as Connection).model.trim()) {
      setError(msg('model_picker.required'));
      return;
    }
    let value = data;
    try { if (initial.kind === 'connections') value = { ...data as Connection, customParameters: JSON.parse(parameters) }; }
    catch { setError(msg("libraries.custom_parameters_must_be_valid_json")); return; }
    if (initial.kind === 'contexts' && initial.id && 'batchSize' in value && 'batchSize' in initial.data
      && (value.batchSize !== initial.data.batchSize || value.promotionGroup !== initial.data.promotionGroup)) {
      const id = initial.id;
      const body = { revision: initial.revision, data: value };
      await reviewMemoryCleanup({
        path: `/library/contexts/${id}/impact`, body, copy: saveMemoryCleanupCopy(), alwaysConfirm: true,
        commit: memoryImpactToken => api(`/library/${id}`, 'PUT', { ...body, kind: 'contexts', memoryImpactToken }),
        saved: committed,
      });
      return;
    }
    if (await run(() => api(initial.id ? `/library/${initial.id}` : '/library', initial.id ? 'PUT' : 'POST', { revision: initial.revision, kind: initial.kind, data: value, ...(initial.kind === 'connections' && (key || removeKey) ? { apiKey: removeKey ? '' : key } : {}) }))) committed();
  }
  function textField(field: string, label: string, multiline = true, full = true) {
    const value = (data as unknown as Record<string, string>)[field];
    return <label className={full ? 'full' : undefined} key={field}>{label}{multiline ? <EditorTextarea value={value} maxLength={100_000} onChange={e => setData({ ...data, [field]: e.target.value })} /> : <input required maxLength={100} value={value} onChange={e => setData({ ...data, [field]: e.target.value })} />}</label>;
  }
  return <NumberDraftContext.Provider value={numberDraft}><form id={formId} onSubmit={e => void save(e)}><LibraryDraftNotice recovered={recovered} storageError={storageError} /><fieldset disabled={busy || stale}><legend>{libraryEditorTitle(initial.kind, Boolean(initial.id))}</legend><div className="form-grid">{textField('name', t("character_editor.name"), false, initial.kind !== 'personas')}
    {initial.kind === 'personas' && <><label>{t("character_editor.title_comment")}<input aria-label={t("character_editor.title_comment")} maxLength={200} value={(data as LibraryPersona).titleComment ?? ''} onChange={event => setData({ ...data, titleComment: event.target.value })} /><small>{t("libraries.an_optional_label_useful_for_distinguishing_between")}</small></label><SpeechColorSelector speaker="persona" value={(data as LibraryPersona).speechColor} change={speechColor => setData({ ...data, speechColor })} disabled={busy || stale} />{textField('description', t("libraries.persona_description"))}</>}
    {initial.kind === 'contexts' && <ContextPresetFields value={data as ContextPreset} change={setData} connections={connections} />}
    {initial.kind === 'connections' && <>
      <label className="full">{t("libraries.api_base_url")}<input type="url" required value={(data as Connection).endpoint} onChange={e => setData({ ...data as Connection, endpoint: e.target.value })} /></label>
      <div className="full api-key-row"><label>{t("libraries.api_key")}<input type="password" autoComplete="new-password" disabled={removeKey} placeholder={initial.hasApiKey ? t("libraries.saved_leave_blank_to_keep_it") : t("libraries.optional_for_endpoints_without_authentication")} value={key} onChange={e => setKey(e.target.value)} /></label>{initial.hasApiKey && <label className="checkbox"><input type="checkbox" checked={removeKey} onChange={e => setRemoveKey(e.target.checked)} />{t("libraries.remove_the_saved_api_key")}</label>}</div>
      <ModelField value={(data as Connection).model} endpoint={(data as Connection).endpoint} connectionId={initial.id}
        apiKey={removeKey ? '' : key || undefined} disabled={busy || stale} change={model => setData({ ...data as Connection, model })} />
      <label>{t("libraries.model_context_window")}<NumberInput draftField="contextWindow" required value={(data as Connection).contextWindow} onChange={contextWindow => setData({ ...data as Connection, contextWindow })} /></label><label>{t("libraries.reserved_output_tokens")}<NumberInput draftField="maxOutputTokens" required max={1_000_000} value={(data as Connection).maxOutputTokens} onChange={maxOutputTokens => setData({ ...data as Connection, maxOutputTokens })} /></label><label className="checkbox full"><input type="checkbox" checked={(data as Connection).requestUsage !== false} onChange={e => setData({ ...data as Connection, requestUsage: e.target.checked })} />{t("libraries.request_token_usage_from_the_endpoint")}</label><p className="small muted full">{t("libraries.turn_statistics_use_counts_supplied_by_the")}</p><label className="full">{t("libraries.custom_request_parameters")}<EditorTextarea className="code-input" value={parameters} onChange={e => setParameters(e.target.value)} /><small>{t("libraries.temperature_top_p_presence_penalty_frequency_penalty")}</small></label>
      <ConnectionTools connection={data as Connection} parameters={parameters} connectionId={initial.id} apiKey={removeKey ? '' : key || undefined} />
    </>}
    {initial.kind === 'prompts' && <div className="full"><p className="small muted">{t("libraries.enabled_blocks_and_markers_compose_the_base", { value: '{{user}}', value2: '{{char}}' })}</p><PromptEditor value={data as PromptPreset} change={setData} /></div>}
  </div></fieldset>{error && <p role="alert">{error}</p>}{stale && <p role="status">{t("libraries.the_library_changed_close_this_editor_and")}</p>}{stale && dirty && <CopyLibraryDraft editor={draft} />}<EditorActions formId={formId} disabled={busy || stale} cancelDisabled={busy} close={close} /></form></NumberDraftContext.Provider>;
}
function ConnectionTools({ connection, parameters, connectionId, apiKey }: { connection: Connection; parameters: string; connectionId?: string; apiKey?: string }) {
  useLocale();
  const [result, setResult] = useState<ConnectionDiagnostic | null>(null), [error, setError] = useTextState('');
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
    } catch (error) { if (attempt.current === id) setError(errorText(error, msg("libraries.connection_test_failed"))); }
    finally { if (attempt.current === id) setTesting(false); }
  }
  return <div className="full connection-tools">
    <div className="actions"><button type="button" className="secondary" disabled={testing} onClick={() => void diagnose('check')}>{t("libraries.check_connection")}</button><button type="button" className="secondary" disabled={testing} onClick={() => void diagnose('test')}>{t("libraries.send_test_message")}</button></div>
    <p className="small muted connection-help">{t("libraries.enter_your_provider_s_api_key_above")}</p>
    {testing && <p className="small" role="status">{t("libraries.testing_connection")}</p>}
    {error && <p role="alert">{error}</p>}
    {result && <div className="connection-test-result" role="status"><p className="small connection-success">{formatMessage(result.localized ?? result.message)}</p>{result.request && <><p className="small">{result.usage ? t("libraries.token_usage_input_output", { value: result.usage.inputTokens.toLocaleString(locale()), value2: result.usage.outputTokens.toLocaleString(locale()) }) : t("libraries.token_usage_unavailable")}</p><details><summary>{t("libraries.test_request_and_response")}</summary><pre>{JSON.stringify({ request: result.request, response: result.response, usage: result.usage }, null, 2)}</pre></details></>}</div>}
  </div>;
}
function ContextPresetFields({ value, change, connections }: { value: ContextPreset; change: (value: ContextPreset) => void; connections: Saved<Connection>[] }) {
  useLocale();
  const fields = [['minTail', t("libraries.minimum_verbatim_turns"), 0], ['batchSize', t("libraries.turns_per_batch"), 1], ['summaryTokens', t("libraries.requested_summary_tokens"), 1], ['promotionGroup', t("libraries.summaries_per_promotion"), 2], ['retainedPerLevel', t("libraries.retain_summaries_per_level"), 0]] as const;
  return <><label className="full">{t("libraries.summarization_connection")}<Dropdown aria-label={t("libraries.summarization_connection")} value={value.connectionId ?? ''} onChange={connectionId => change({ ...value, connectionId: connectionId || null })} options={[{ value: '', label: t("libraries.same_as_current_chat_connection") }, ...connections.map(connection => ({ value: connection.id, label: `${connection.name} · ${connection.model}` }))]} /></label>
    {fields.map(([field, label, min]) => <label key={field}>{label}<NumberInput draftField={field} required min={min} max={field === 'summaryTokens' ? 1_000_000 : 50_000} value={value[field]} onChange={number => change({ ...value, [field]: number })} /></label>)}
    <p className="small muted full">{t("libraries.the_input_target_belongs_to_each_chat")}</p>
    <label className="full">{t("libraries.first_layer_extraction_prompt")}<EditorTextarea required value={value.extractionPrompt} maxLength={100_000} onChange={e => change({ ...value, extractionPrompt: e.target.value })} /></label>
    <label className="full">{t("libraries.higher_layer_compression_prompt")}<EditorTextarea required value={value.promotionPrompt} maxLength={100_000} onChange={e => change({ ...value, promotionPrompt: e.target.value })} /></label>
    <label className="full">{t("libraries.repair_prompt")}<EditorTextarea required value={value.repairPrompt} maxLength={100_000} onChange={e => change({ ...value, repairPrompt: e.target.value })} /></label>
    <p className="small muted full">{t("libraries.repair_receives_the_existing_summary_and_before")}</p>
    <p className="small muted full">{t("libraries.available_variables_source_text_is_attached_separately", { value: '{{target_tokens}}', value2: '{{level}}', value3: '{{user}}', value4: '{{char}}' })}</p>
  </>;
}
function PromptEditor({ value, change }: { value: PromptPreset; change: (value: PromptPreset) => void }) {
  useLocale();
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(() => new Set());
  function update(index: number, block: PromptBlock) { change({ ...value, blocks: value.blocks.map((old, i) => i === index ? block : old) }); }
  function move(from: number, to: number) {
    if (to < 0 || to >= value.blocks.length || from === to) return;
    change({ ...value, blocks: moveListItem(value.blocks, from, to) });
  }
  const reorder = useListReorder(move);
  return <><WarningMessages messages={promptWarningMessages(value)} /><div className="prompt-blocks" {...reorder.list}>{value.blocks.map((block, index) => {
    const expanded = expandedBlocks.has(block.id);
    return <section className={`prompt-block${reorder.rowClass(index, value.blocks.length)}`} aria-label={t("libraries.prompt_block", { value: index + 1 })} key={block.id}>
      <div className="block-heading">
        <span {...reorder.handle(index, block.id)} title={t("libraries.drag_to_reorder")} className="drag-handle" aria-label={t("libraries.drag_block", { value: index + 1 })}><Icon name="Menu" /></span>
        <input type="checkbox" aria-label={t("libraries.enable_block", { value: index + 1 })} checked={block.enabled} onChange={event => update(index, { ...block, enabled: event.target.checked })} />
        <label className="block-name">{t("libraries.block_name")}<input required value={block.name} onChange={event => update(index, { ...block, name: event.target.value })} /></label>
        <label className="block-role">{t("libraries.role")}<Dropdown aria-label={t("libraries.role_for_block", { value: index + 1 })} disabled={block.kind === 'marker' && block.marker === 'messages'} value={block.role} onChange={role => update(index, { ...block, role: role as PromptBlock['role'] })} options={['system', 'user', 'assistant'].map(role => ({ value: role, label: stateLabel(role === 'system' || role === 'user' ? role : 'assistant') }))} /></label>
        <div className="block-actions"><button type="button" className="quiet" title={t("libraries.move_up")} aria-label={t("libraries.move_block_up", { value: index + 1 })} disabled={index === 0} onClick={() => move(index, index - 1)}><Icon name="ArrowLongTop" /></button><button type="button" className="quiet" title={t("libraries.move_down")} aria-label={t("libraries.move_block_down", { value: index + 1 })} disabled={index === value.blocks.length - 1} onClick={() => move(index, index + 1)}><Icon name="ArrowLongBottom" /></button><button type="button" className="quiet" title={t("libraries.delete_block")} aria-label={t("libraries.remove_block", { value: index + 1 })} onClick={() => change({ ...value, blocks: value.blocks.filter((_, i) => i !== index) })}><Icon name="TrashOutline" /></button><button type="button" className="quiet block-toggle" aria-expanded={expanded} aria-controls={`block-content-${block.id}`} title={expanded ? t("libraries.collapse_block") : t("libraries.expand_block")} aria-label={t(expanded ? "libraries.collapse_block_number" : "libraries.expand_block_number", { number: index + 1 })} onClick={() => setExpandedBlocks(old => { const next = new Set(old); if (expanded) next.delete(block.id); else next.add(block.id); return next; })}><Icon name={expanded ? 'ArrowShortTop' : 'ArrowShortBottom'} /></button></div>
      </div>
      {expanded && <div className="block-content" id={`block-content-${block.id}`}>
        {block.kind === 'text' ? <label>{t("libraries.block_text")}<EditorTextarea value={block.text} onChange={event => update(index, { ...block, text: event.target.value })} /></label> : <>
          <label>{t("libraries.marker_source")}<Dropdown aria-label={t("libraries.marker_source_for_block", { value: index + 1 })} value={block.marker} onChange={selected => {
            const marker = markers.find(marker => marker === selected);
            if (!marker || marker === block.marker) return;
            const { fields: _fields, fallback: _fallback, allowDepthPrompt: _allowDepthPrompt, ...base } = block;
            update(index, { ...base, name: block.name === 'Marker' || block.name === markerLabel(block.marker) ? markerLabel(marker) : block.name, marker, ...(marker === 'character' ? { fields: [...characterFields] } : {}) });
          }} options={markers.map(marker => ({ value: marker, label: localizedMarkerLabel(marker) }))} /></label>
          {(block.marker === 'card_system_prompt' || block.marker === 'card_post_history_instructions') && <label>{t("libraries.fallback_text")}<EditorTextarea aria-label={t("libraries.fallback_text")} maxLength={100_000} value={block.fallback ?? ''} onChange={event => update(index, { ...block, fallback: event.target.value })} /><small>{t("libraries.used_when_the_card_field_is_empty", { value: '{{original}}' })}</small></label>}
          {block.marker === 'messages' && <label className="checkbox messages-marker-option"><input type="checkbox" checked={block.allowDepthPrompt ?? false} onChange={event => update(index, { ...block, allowDepthPrompt: event.target.checked })} />{t("libraries.allow_character_depth_prompt_injection")}</label>}
          {block.marker === 'character' && <MarkerFieldSelection label={t("libraries.included_character_fields")} options={characterFields.map(field => ({ value: field, label: characterFieldLabel(field) }))} selected={block.fields ?? [...characterFields]} change={fields => update(index, { ...block, fields })} />}
        </>}
      </div>}
    </section>;
  })}</div><div className="actions"><button type="button" className="secondary" disabled={value.blocks.length >= 100} onClick={() => change({ ...value, blocks: [...value.blocks, { id: newId(), name: 'Text', enabled: true, kind: 'text', role: 'system', text: '' }] })}>{t("libraries.add_text_block")}</button><button type="button" className="secondary" disabled={value.blocks.length >= 100} onClick={() => change({ ...value, blocks: [...value.blocks, { id: newId(), name: 'Marker', enabled: true, kind: 'marker', role: 'system', marker: 'description' }] })}>{t("libraries.add_marker")}</button></div></>;
}

function MarkerFieldSelection<T extends string>({ label, options, selected, change }: { label: string; options: readonly { value: T; label: string }[]; selected: readonly T[]; change: (selected: T[]) => void }) {
  useLocale();
  return <fieldset className="marker-fields"><legend>{label}</legend><p className="small muted">{t("libraries.checked_fields_become_separate_messages_in_this")}</p><div className="marker-field-options">{options.map(option => <label className="checkbox" key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={event => change(options.filter(candidate => candidate.value === option.value ? event.target.checked : selected.includes(candidate.value)).map(candidate => candidate.value))} />{option.label}</label>)}</div></fieldset>;
}
