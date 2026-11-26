import { moveListItem, useListReorder } from './useListReorder';
import { LibraryImport } from './LibraryImport';
import { ActionMenu } from './ActionMenu';
import { LibrarySearchField } from './LibrarySearchField';
import type { MessageText } from './localization';
import { libraryEditorTitle, newLibraryLabel, searchLibraryLabel, sortLibraryLabel } from './localization-labels';
import { LocalizedError, formatMessage, useTextState, errorText, t, message as msg, useLocale, locale, currentPack } from './localization';
import { libraryLabel, characterFieldLabel, markerLabel as localizedMarkerLabel, stateLabel } from './localization-labels';
import { librarySortSchema, readLibrarySort, sortLibraryItems, sortLibraryRecords, sortOptions, type LibrarySort } from './library-sorting';
import { defaultContinuationInstruction, defaultOpeningInstruction } from '../shared/default-prompt';
import { chatGroupId, preferredBranch } from './chat-selection';
import { ChatCardActivity } from './ChatCardActivity';
import { SpeechColorSelector } from './SpeechColorSelector';
import type { ChatPreviewAppearance } from './ChatTextPreview';
import { newId } from './uuid';
import { Icon } from './Icon';
import { PersonaIcon } from './PersonaIcon';
import type { ChatDefaultsStatus, ChatDefaultKind } from '../shared/chat-defaults';
import { useConfirmation } from './Confirmation';
import { LibraryDeletionDialog, readDeletionRetry, type LibraryDeletionTarget } from './LibraryDeletionDialog';
import { WarningDialog, WarningMessages } from './WarningDialog';
import { saveMemoryCleanupCopy, useMemoryCleanup } from './MemoryCleanupReview';
import { CharacterAvatar, PictureSquare } from './Pictures';
import { LibraryCard } from './LibraryCard';
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEventHandler, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { connectionSettings, outputFitsContextWindow, type Connection, type ConnectionRecord, type ConnectionDiagnostic, type DiscoveredModel } from '../shared/contracts';
import { characterLabel, personaLabel, characterFields, defaultPrompt, markers, markerLabel, promptWarningMessages, type ChatSummary, type LibraryCharacter, type LibraryPersona, type LibraryKind, type LibrarySnapshot, type PromptBlock, type PromptPreset, type Saved } from '../shared/library';
import { upgradePrompt } from '../core/prompt-upgrade';
import { TranscriptImport } from './TranscriptImport';
import { CharacterImport } from './CharacterImport';
import { ConnectionFileDialog, type ConnectionFileAction } from './ConnectionFileDialog';
import { ConnectionFields, type ConnectionTab } from './ConnectionFields';
import { ConnectionFieldError, connectionParameterDraft, parseConnectionParameters, recoverConnectionParameters, type ConnectionParameterDraft } from './connection-parameter-draft';
import { CharacterEditor } from './CharacterEditor';
import { EditorActions, EditorActionsTarget } from './EditorActions';
import type { LeaveEditor } from './EditorLeaveGuard';
import { ContextPresetFields } from './ContextPresetFields';
import { EditorTabs } from './EditorTabs';
import { EditorTextarea } from './EditorTextarea';
import { TagChips, TagFilterMenu } from './Tags';
import { characterTagIndex, matchesCharacterTags } from '../shared/tags';
import { api, datasetEpoch } from './api';
import { Dropdown, NumberDraftContext, useNumberDraft } from './Controls';
import { defaultContextPreset, type ContextPreset } from '../shared/context';
import { newLorebook, type Lorebook, type LoreDiagnostic } from '../shared/lorebook';
import { LorebookEditor, LorebookImport, LoreDiagnostics } from './LorebookEditor';
import { CopyLibraryDraft, LibraryDraftNotice, StaleLibraryDraft, useLibraryEditorDraft } from './LibraryDraft';
import { sameDraftValue, type DraftOf, type LibraryDraft, type LibraryEditorDraft, type SetupReturn } from './library-draft';

export const defaultConnection: Connection = { name: 'My Connection', endpoint: 'https://api.openai.com/v1', model: '', contextWindow: 128_000, maxOutputTokens: 8196, customParameters: {} };

function newPrompt(): PromptPreset {
  const sourceMarkers = defaultPrompt.blocks.filter(block => block.kind === 'marker')
    .map(block => ({ ...structuredClone(block), name: markerLabel(block.marker) }));
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
type LibraryRecord = LibraryCharacter | LibraryPersona | PromptPreset | ConnectionRecord | ContextPreset | Lorebook;

function libraryCardDetails(item: LibraryRecord): string | undefined {
  if ('entries' in item) {
    const total = item.entries.length;
    const enabled = item.entries.filter(entry => entry.enabled).length;
    return enabled === total
      ? t('libraries.entry_count', { count: total })
      : t('libraries.entries_enabled', { length: total, length2: enabled });
  }
  if ('blocks' in item) return t('libraries.block_count', { count: item.blocks.length });
  if ('minTail' in item) return t('libraries.minimum_tail_batch', { minTail: item.minTail, batchSize: item.batchSize });
}

type LibraryCategory = LibraryKind | 'chats';
const libraryCategories = ['chats', 'characters', 'personas', 'lorebooks', 'prompts', 'connections', 'contexts'] as const satisfies readonly LibraryCategory[];

function lastLibrarySection(): LibraryCategory {
  try {
    const value = localStorage.getItem('roleplay-library-section');
    return libraryCategories.find(category => category === value) ?? 'chats';
  } catch { return 'chats'; }
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
const libraryIcons: Record<LibraryCategory, ReactNode> = {
  chats: <Icon name="ChatOutline" />,
  personas: <PersonaIcon />,
  characters: <Icon name="Profile" />,
  lorebooks: <Icon name="FolderOutline" />,
  prompts: <Icon name="TextbookOutline" />,
  connections: <Icon name="Link" />,
  contexts: <Icon name="FilterOutline" />,
};

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
export type SetupLibrary = 'connections' | 'characters' | 'personas';
type SetupParticipant = { kind: 'characters' | 'personas'; id: string };
export type LibraryDestination = LibraryTarget
  | { kind: LibraryKind | 'chats'; action: 'browse' }
  | { kind: SetupLibrary; action: 'create'; returnTo: SetupReturn }
  | (SetupParticipant & { action: 'edit'; returnTo: 'story' });
type LibraryEditing = {
  kind: LibraryKind; id?: string; revision: number; data: LibraryRecord; hasApiKey?: boolean; returnTo?: SetupReturn;
  listScrollTop?: number;
};

function libraryScroller(panel: HTMLElement | null) {
  if (!panel) return null;
  // Phones scroll the heading and content together in the workspace.
  return getComputedStyle(panel).overflowY === 'visible' ? panel.parentElement : panel;
}

function savedEditor(library: LibrarySnapshot, kind: LibraryKind, id: string, returnTo?: SetupReturn): LibraryEditing | null {
  const record = library[kind].find(record => record.id === id);
  if (!record) return null;
  const { id: _id, revision: _revision, hasApiKey, ...data } = { ...record, hasApiKey: 'hasApiKey' in record && record.hasApiKey };
  return { kind, id, revision: library.revision, data, hasApiKey, returnTo };
}

function newEditor(kind: LibraryKind, revision: number): LibraryEditing {
  const data = kind === 'lorebooks' ? newLorebook() : kind === 'connections' ? defaultConnection : kind === 'contexts' ? { ...structuredClone(defaultContextPreset), name: newLibraryLabel('contexts') } : kind === 'prompts' ? newPrompt() : kind === 'personas' ? { name: '', titleComment: '', description: '' } : { name: '', titleComment: '', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', lorebookId: null };
  return { kind, revision, data };
}

export function Libraries({ library, defaults, appearance, currentBranchId, branchSelections, busy, run, openChat, openNewChat, initialTarget, recoveredDraft, leaveEditor, clearDraft, setupFinished }: {
  library: LibrarySnapshot;
  defaults: ChatDefaultsStatus;
  appearance: ChatPreviewAppearance;
  currentBranchId: string | null;
  branchSelections: ReadonlyMap<string, string>;
  busy: boolean;
  run: Run;
  openChat: (id: string, destination?: 'story' | 'settings') => void;
  openNewChat: () => void;
  initialTarget?: LibraryDestination | null;
  recoveredDraft: LibraryDraft | null;
  leaveEditor: LeaveEditor;
  clearDraft: () => void;
  setupFinished: (destination: SetupReturn, participant?: SetupParticipant) => void;
}) {
  useLocale();
  const [recovery, setRecovery] = useState(recoveredDraft);
  const [section, setSection] = useState<LibraryCategory>(recovery?.editor.kind ?? initialTarget?.kind ?? lastLibrarySection);
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
      const returnTo = 'returnTo' in recovery.editor ? recovery.editor.returnTo : undefined;
      if (id) return savedEditor(library, kind, id, returnTo);
      return { ...newEditor(kind, revision), returnTo };
    }
    if (!initialTarget) return null;
    if ('id' in initialTarget) {
      const returnTo = 'returnTo' in initialTarget ? initialTarget.returnTo : undefined;
      return savedEditor(library, initialTarget.kind, initialTarget.id, returnTo);
    }
    if (initialTarget.action === 'create') return { ...newEditor(initialTarget.kind, library.revision), returnTo: initialTarget.returnTo };
    return null;
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
  function finishEditor(participant?: SetupParticipant) {
    if (!mounted.current) return;
    closeEditor();
    const destination = editing?.returnTo ?? (recovery && 'returnTo' in recovery.editor ? recovery.editor.returnTo : undefined);
    if (destination) setupFinished(destination, participant);
  }
  const cancelEditor: MouseEventHandler<HTMLButtonElement> = event => leaveEditor(() => finishEditor(), { returnFocus: event.currentTarget });
  const reviewMemoryCleanup = useMemoryCleanup(run, `${section}:${editing?.id ?? editing?.kind ?? ''}`);
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);
  const panel = useRef<HTMLElement>(null);
  const categoryTrigger = useRef<HTMLButtonElement>(null);
  const previousEditor = useRef(editing);
  const previousSection = useRef(section);
  useLayoutEffect(() => {
    const closedEditor = previousEditor.current;
    const changedSection = previousSection.current !== section;
    previousEditor.current = editing;
    previousSection.current = section;
    if (!closedEditor || editing) {
      if (changedSection) libraryScroller(panel.current)?.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      return;
    }
    const scroller = libraryScroller(panel.current);
    if (!scroller) return;
    const top = closedEditor.kind === section ? closedEditor.listScrollTop ?? 0 : 0;
    const overflow = scroller.style.overflow;
    // Remove the scrolling box for a rendered frame to stop editor momentum
    // before restoring the list position.
    scroller.style.overflow = 'clip';
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        scroller.style.overflow = overflow;
        scroller.scrollTo({ left: 0, top, behavior: 'instant' });
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      scroller.style.overflow = overflow;
    };
  }, [editing, section]);
  const [deletion, setDeletion] = useState<LibraryDeletionTarget | null>(() => readDeletionRetry()?.target ?? null);
  const [connectionFile, setConnectionFile] = useState<ConnectionFileAction | null>(null);
  const [notice, setNotice] = useTextState(''), [diagnostics, setDiagnostics] = useState<LoreDiagnostic[]>([]), [search, setSearch] = useState('');
  const [warning, setWarning] = useState<{ message: MessageText; returnFocus?: HTMLElement | null } | null>(null);
  const presetImportTrigger = useRef<HTMLButtonElement>(null);
  const [pendingBook, setPendingBook] = useState<string | null>(null);
  const [filters, setFilters] = useState<string[]>([]);
  function changeSection(kind: LibraryCategory, returnFocus?: HTMLElement) {
    leaveEditor(() => {
      if (kind !== 'characters') setFilters([]);
      setSection(kind);
      closeEditor();
      setNotice('');
      setDiagnostics([]);
      setSearch('');
    }, { returnFocus });
  }
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
  const chatDateFormat = useMemo(() => new Intl.DateTimeFormat(displayLanguage.locale, {
    dateStyle: 'medium', timeStyle: 'short',
  }), [displayLanguage.locale]);
  const visibleRecords = useMemo<Saved<LibraryRecord>[]>(() => {
    if (section === 'chats') return [];
    return sortLibraryItems(library[section].filter(record => matchesLibraryRecord(record, query)
      && (section !== 'characters' || matchesCharacterTags(tagIndex.get(record.id), filters))), sort, record => characterLabel(record), record => library.dates[record.id]);
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
  function editRecord(id: string) {
    if (section === 'chats') return;
    const editor = savedEditor(library, section, id);
    if (!editor) return;
    setEditing({ ...editor, listScrollTop: libraryScroller(panel.current)?.scrollTop });
  }
  function renderEditor(initial: LibraryEditing) {
    const recovered = recovery?.editor;
    if (initial.kind === 'characters' && 'personality' in initial.data) {
      return <CharacterEditor key={initial.id ?? 'new-character'} initial={{ ...initial, data: initial.data }}
        recovered={recovered?.kind === 'characters' ? recovered : undefined} library={library} appearance={appearance} busy={busy} run={run}
        close={cancelEditor} openBook={openBook}
        saved={id => {
          setNotice(msg("libraries.character_saved", { value: filters.length ? t("interface.it_may_be_hidden_by_your_tag_filters") : '' }));
          finishEditor(id ? { kind: 'characters', id } : undefined);
        }}
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
      connections={initial.kind === 'contexts' ? sortLibraryRecords(library.connections, 'connections', library.dates) : []}
      currentRevision={library.revision} appearance={appearance} busy={busy} run={run}
      close={cancelEditor} committed={id => finishEditor(id && initial.kind === 'personas' ? { kind: 'personas', id } : undefined)} />;
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
        {libraryCategories.map(kind => <button
          type="button"
          aria-pressed={section === kind}
          key={kind}
          disabled={busy && editorOpen}
          onClick={event => changeSection(kind, event.currentTarget)}
        >{libraryIcons[kind]}{libraryLabel(kind)}</button>)}
      </nav>
      </div>
      <div className="library-editor-target" ref={setActionsTarget} />
    </aside>
    {/* Keep the heading mounted so the picker retains focus when the category changes. */}
    <section ref={panel} className="document-panel library-panel" aria-labelledby="library-heading">
    <LibraryHeader editing={editorOpen}>
      <h1 id="library-heading" aria-label={libraryLabel(section)}>
        <span className="library-desktop-heading">{libraryLabel(section)}</span>
        <Dropdown presentation="heading" triggerRef={categoryTrigger} aria-label={t('libraries.library_categories')}
          value={section} disabled={busy && editorOpen}
          options={libraryCategories.map(kind => ({ value: kind, label: libraryLabel(kind), leading: libraryIcons[kind] }))}
          onChange={value => {
            const kind = libraryCategories.find(category => category === value);
            if (kind && kind !== section) changeSection(kind, categoryTrigger.current ?? undefined);
          }} />
      </h1>
      <Fragment key={section}>
      {section === 'chats' && <div className="actions library-toolbar" role="group" aria-label={t("character_import.library_actions")}><button disabled={busy} onClick={openNewChat}><Icon name="AddToList" />{t("libraries.new_chat")}</button>
        <TranscriptImport destination={{ kind: 'chat', library }} disabled={busy} created={id => openChat(id, 'settings')} />
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
      {!editorOpen && <LibrarySearch section={section} value={search} change={setSearch} sort={sort} changeSort={changeSort}>
        {section === 'characters' && <TagFilterMenu library={library} busy={busy} run={run} selected={filters} change={setFilters} />}
      </LibrarySearch>}
      </Fragment>
    </LibraryHeader>
    <Fragment key={section}>
    {notice && <p className="library-notice" role="status">{notice}</p>}<LoreDiagnostics diagnostics={diagnostics} />
    {warning && <WarningDialog {...warning} close={() => setWarning(null)} />}
    {section === 'chats' ? <>
      <div className="library-list chat-list">
        {visibleChats.map(({ id, branch, branches, lastMessageAt, running }) => {
          const isCurrent = currentBranchId === branch.id;
          const messageTime = lastMessageAt ? Date.parse(lastMessageAt) : NaN;
          return <article key={id} className="chat-card">
            <CharacterAvatar url={branch.characterId ? pictureIndex.get(branch.characterId)?.thumbnailUrl : undefined} />
            <div className="chat-card-text">
              <h2><button type="button" className="chat-card-open" aria-current={isCurrent || undefined}
                onClick={() => openChat(branch.id)}>{branch.title}</button></h2>
              <div className="chat-card-meta">
                <span>{t('counts.turns', { count: branch.turnCount })}</span>
                {isCurrent && <span className="chat-card-current">{t('chat_workspace.current_chat')}</span>}
                {running && <span>{t('branches.response_running')}</span>}
              </div>
            </div>
            {lastMessageAt && Number.isFinite(messageTime)
              ? <ChatCardActivity key={lastMessageAt} timestamp={lastMessageAt} messageTime={messageTime} dateFormat={chatDateFormat} />
              : branches.every(item => item.turnCount === 0) &&
                <span className="chat-card-activity">{t('libraries.chat_no_messages')}</span>}
            <div className="chat-card-actions">
              <ActionMenu label={t('libraries.actions_for', { name: branch.title })} disabled={busy || running} revision={branch.revision}>
                <button type="button" className="secondary" role="menuitem" tabIndex={-1} aria-haspopup="dialog" onClick={() => {
                  confirmAction({
                    confirmOnEnter: true, title: msg('libraries.delete_chat'),
                    message: msg(branches.length > 1 ? 'branches.delete_chat' : 'libraries.delete_and_all_its_turns_and_requests', { title: branch.title }),
                    actionLabel: msg('libraries.delete_chat_2'),
                    onConfirm: () => { void run(() => api(`/chats/${branch.id}`, 'DELETE', {
                      revision: branch.revision, branches: branches.map(({ id, revision }) => ({ id, revision })),
                    })); },
                  });
                }}><Icon name="TrashOutline" />{t('libraries.delete_chat_2')}</button>
              </ActionMenu>
            </div>
          </article>;
        })}
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
      <div className={`library-list ${section === 'characters' || section === 'personas' ? 'participant-card-list' : 'soft-card-list'}`}>
        {visibleRecords.map(item => <LibraryCard key={item.id} title={item}
          picture={section === 'characters' ? <PictureSquare url={pictureIndex.get(item.id)?.thumbnailUrl} /> : undefined}
          disabled={busy} open={() => editRecord(item.id)}
          description={'model' in item ? item.model : 'description' in item ? item.description : ''}
          details={libraryCardDetails(item)}
          tools={<>
            {(section === 'prompts' || section === 'connections' || section === 'contexts') && <DefaultBookmark kind={section} item={item} defaults={defaults} libraryRevision={library.revision} busy={busy} run={run} />}
            <ActionMenu label={t('libraries.actions_for', { name: characterLabel(item) })} disabled={busy} revision={library.revision}>
              <button className="secondary" role="menuitem" tabIndex={-1} aria-label={section === 'characters' ? t("libraries.duplicate", { value: characterLabel(item) }) : undefined} disabled={busy} onClick={() => void run(() => duplicate(item))}><Icon name="CopyOutline" />{t("libraries.duplicate_2")}</button>
              {section === 'connections' ? <button type="button" className="secondary" role="menuitem" tabIndex={-1} disabled={busy} aria-haspopup="dialog" onClick={() => {
                setConnectionFile({ kind: 'export', id: item.id, name: item.name });
              }}><Icon name="Upload" />{t('connection_files.export_button')}</button> : <button className="secondary" role="menuitem" tabIndex={-1} aria-label={section === 'characters' ? t("libraries.export_json", { value: characterLabel(item) }) : undefined} onClick={() => void run(async () => download(await api(`/library/${section}/${item.id}/export`), `${item.name.replace(/[^a-z0-9_-]/gi, '_')}.json`))}><Icon name="Upload" />{section === 'characters' ? t("libraries.export_json_2") : t("libraries.export")}</button>}
              {section === 'prompts' && item.id === 'default' && <button className="secondary" role="menuitem" tabIndex={-1} disabled={busy} onClick={() => { confirmAction({ title: t("libraries.restore_original_prompt"), message: t("libraries.restore_the_built_in_default_prompt_chats", { name: defaultPrompt.name }), actionLabel: t("libraries.restore_original"), onConfirm: () => { void run(() => api('/library/default/restore', 'POST', { revision: library.revision })); } }); }}><Icon name="TrashOutline" />{t("libraries.restore_original")}</button>}
              {section === 'contexts' && item.id === 'default-context' && <button className="secondary" role="menuitem" tabIndex={-1} disabled={busy} onClick={() => {
                const revision = library.revision;
                void reviewMemoryCleanup({
                  path: '/library/contexts/default-context/impact', body: { revision, data: defaultContextPreset }, alwaysConfirm: true,
                  copy: { title: msg('libraries.reset_context'), message: msg('libraries.reset_context_confirmation', { name: defaultContextPreset.name }), actionLabel: msg('libraries.reset') },
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
          </>} />)}{library[section].length === 0 && <p className="muted">{t("libraries.empty_section")}</p>}{section !== 'characters' && query && visibleRecords.length === 0 && library[section].length > 0 && <p className="muted" role="status">{t("libraries.no_match_your_search", { value: libraryLabel(section).toLowerCase() })}</p>}</div>
      {section === 'characters' && library.characters.length > 0 && visibleRecords.length === 0 && <p role="status">{query ? filters.length ? t("libraries.no_characters_match_your_search_and_selected") : t("libraries.no_characters_match_your_search") : t("libraries.no_characters_match_all_selected_tags_clear")}</p>}
      </>}
    </>}
    </Fragment>
    </section>
  </main>{deletion && <LibraryDeletionDialog target={deletion}
    name={library[deletion.kind].find(item => item.id === deletion.id)?.name}
    dates={library.dates} busy={busy} run={run} cancel={() => setDeletion(null)} complete={() => {
      setDeletion(null);
      setNotice('');
    }} />}{connectionFile && <ConnectionFileDialog action={connectionFile} cancel={() => setConnectionFile(null)} complete={kind => {
    setConnectionFile(null);
    setNotice(kind === 'import' ? msg('connection_files.imported') : '');
    if (kind === 'import') void run(async () => {});
  }} />}</div></EditorActionsTarget.Provider>;
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
type ContextWindowSource = DraftOf<'connections'>['contextWindowSource'];

function comparableLibraryFields(data: StandardDraft['data']) {
  if ('description' in data) return { ...data, titleComment: data.titleComment ?? '', speechColor: data.speechColor ?? null };
  return data;
}

function connectionFromDraft(connection: ConnectionRecord, parameters: ConnectionParameterDraft): ConnectionRecord {
  if (!connection.model.trim()) throw new ConnectionFieldError(msg('model_picker.required'), 'model');
  return { ...connection, customParameters: parseConnectionParameters(parameters) };
}

function LibraryEditor({ initial, recovered, connections, currentRevision, appearance, busy, run, close, committed }: { initial: LibraryEditing & { data: StandardDraft['data'] }; recovered?: StandardDraft; connections: Saved<Connection>[]; currentRevision: number; appearance: ChatPreviewAppearance; busy: boolean; run: Run; close: MouseEventHandler<HTMLButtonElement>; committed: (id?: string) => void }) {
  useLocale();
  const formId = useId();
  const [data, setData] = useState(recovered?.data ?? initial.data);
  const connection = 'endpoint' in data ? data : undefined;
  const contextPreset = 'batchSize' in data ? data : undefined;
  const baselineWindow = 'endpoint' in initial.data ? initial.data.contextWindow : defaultConnection.contextWindow;
  const [windowSource, setWindowSource] = useState<ContextWindowSource>(() => {
    if (recovered?.kind !== 'connections') return undefined;
    if (recovered.contextWindowSource) return recovered.contextWindowSource;
    if (recovered.data.contextWindow !== baselineWindow || recovered.numbers?.contextWindow !== undefined) return 'manual';
  });
  const [key, setKey] = useState('');
  const [removeKey, setRemoveKey] = useState(recovered?.kind === 'connections' && recovered.removeKey);
  const [baselineParameters] = useState(() => connectionParameterDraft('customParameters' in initial.data ? initial.data.customParameters : {}));
  const [parameters, setParameters] = useState(() => recovered?.kind === 'connections'
    ? recoverConnectionParameters(recovered.data.customParameters, recovered) : baselineParameters);
  const numberDraft = useNumberDraft(recovered?.numbers);
  const [connectionTab, setConnectionTab] = useState<ConnectionTab>('settings');
  const outputConflict = connection !== undefined && numberDraft.values.contextWindow === undefined && numberDraft.values.maxOutputTokens === undefined
    && !outputFitsContextWindow(connection);
  const keyOmitted = !removeKey && key !== '';
  const draft = useMemo<StandardDraft>(() => {
    const target = { id: initial.id, revision: initial.revision, numbers: numberDraft.values };
    if ('endpoint' in data) return { ...target, kind: 'connections', returnTo: initial.returnTo, data, ...parameters, removeKey, keyOmitted, contextWindowSource: windowSource };
    if ('blocks' in data) return { ...target, kind: 'prompts', data };
    if ('batchSize' in data) return { ...target, kind: 'contexts', data };
    return { ...target, kind: 'personas', returnTo: initial.returnTo, data };
  }, [initial.id, initial.revision, initial.returnTo, data, parameters, removeKey, keyOmitted, numberDraft.values, windowSource]);
  const dataChanged = useMemo(() => data !== initial.data && !sameDraftValue(comparableLibraryFields(data), comparableLibraryFields(initial.data)), [data, initial.data]);
  const dirty = dataChanged || !sameDraftValue(parameters, baselineParameters) || removeKey || key !== '' || numberDraft.dirty;
  const storageError = useLibraryEditorDraft(draft, dirty);
  const [error, setError] = useTextState('');
  const [staleWarningDismissed, setStaleWarningDismissed] = useState(false);
  const stale = initial.revision !== currentRevision;
  const reviewMemoryCleanup = useMemoryCleanup(run, initial.id);
  const rememberModelWindow = useCallback((endpoint: string, model: DiscoveredModel) => {
    setData(current => {
      if (!('endpoint' in current) || current.endpoint !== endpoint || current.model !== model.id
        || current.modelWindowReport?.tokens === model.contextWindow) return current;
      return { ...current, modelWindowReport: model.contextWindow === undefined ? undefined
        : { endpoint, model: model.id, tokens: model.contextWindow } };
    });
  }, []);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || stale || outputConflict) return;
    setError('');
    let value = data;
    if ('endpoint' in data) {
      try {
        value = connectionFromDraft(data, parameters);
      } catch (error) {
        if (!(error instanceof ConnectionFieldError)) throw error;
        flushSync(() => {
          if (error.field !== 'model') setConnectionTab('parameters');
          setError(error.localized);
        });
        const control = e.currentTarget.elements.namedItem(error.field);
        if (control instanceof HTMLElement) {
          const disclosure = control.closest('details');
          if (disclosure) disclosure.open = true;
          control.focus();
        }
        return;
      }
    }
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
    const request: { result?: { id: string } } = {};
    if (await run(async () => {
      request.result = await api<{ id: string }>(initial.id ? `/library/${initial.id}` : '/library', initial.id ? 'PUT' : 'POST', {
        revision: initial.revision, kind: initial.kind, data: value,
        ...(initial.kind === 'connections' && (key || removeKey) ? { apiKey: removeKey ? '' : key } : {}),
      });
    })) committed(request.result?.id);
  }
  function textField(field: string, label: string, multiline = true, full = true, help?: string) {
    const value = (data as unknown as Record<string, string>)[field];
    const helpId = `${formId}-${field}-help`;
    const helpAttributes = help ? { 'aria-label': label, 'aria-describedby': helpId } : {};
    return <label className={full ? 'full' : undefined} key={field}>{label}
      {multiline
        ? <EditorTextarea {...helpAttributes} value={value} maxLength={100_000} onChange={event => setData({ ...data, [field]: event.target.value })} />
        : <input {...helpAttributes} required maxLength={100} value={value} onChange={event => setData({ ...data, [field]: event.target.value })} />}
      {help && <small id={helpId}>{help}</small>}
    </label>;
  }
  const personaNameHelp = initial.kind === 'personas' ? t('libraries.persona_name_help', { user: '{{user}}' }) : undefined;
  return <NumberDraftContext.Provider value={numberDraft}><form id={formId} onSubmit={e => void save(e)}><LibraryDraftNotice recovered={recovered} storageError={storageError} /><fieldset disabled={busy} className={contextPreset || connection ? 'tabbed-library-editor' : undefined}>
    <legend className={contextPreset || connection ? 'sr-only' : undefined}>{libraryEditorTitle(initial.kind, Boolean(initial.id))}</legend>
    {contextPreset ? <ContextPresetFields value={contextPreset} change={setData} connections={connections} /> : connection ? <>
      <ConnectionFields value={connection} change={setData} id={initial.id} hasApiKey={initial.hasApiKey}
        apiKey={key} setApiKey={setKey} removeKey={Boolean(removeKey)} setRemoveKey={setRemoveKey}
        windowSource={windowSource} setWindowSource={setWindowSource} baselineWindow={baselineWindow}
        numberDraft={numberDraft} outputConflict={outputConflict} busy={busy}
        reportWindow={rememberModelWindow} tab={connectionTab} selectTab={setConnectionTab} parameters={parameters} setParameters={setParameters} />
      <ConnectionTools connection={connectionSettings(connection)} parameters={parameters} connectionId={initial.id}
        apiKey={removeKey ? '' : key || undefined} disabled={stale || outputConflict} />
    </> :
    <div className="form-grid">{textField('name', t("character_editor.name"), false, initial.kind !== 'personas', personaNameHelp)}
    {initial.kind === 'personas' && <>
      <label>{t("character_editor.title_comment")}<input aria-label={t("character_editor.title_comment")} maxLength={200} value={(data as LibraryPersona).titleComment ?? ''} onChange={event => setData({ ...data, titleComment: event.target.value })} /><small>{t("libraries.an_optional_label_useful_for_distinguishing_between")}</small></label>
      <SpeechColorSelector speaker="persona" appearance={appearance} value={(data as LibraryPersona).speechColor} change={speechColor => setData({ ...data, speechColor })} disabled={busy} />
      {textField('description', t('libraries.persona_description'), true, true, t('libraries.persona_description_help'))}
    </>}
    {initial.kind === 'prompts' && <PromptEditor value={data as PromptPreset} change={setData} />}
  </div>}</fieldset>
    {error && <p className={connection ? 'small connection-error' : undefined} role="alert">{error}</p>}
    {stale && !staleWarningDismissed && <WarningDialog message={msg('libraries.the_library_changed_close_this_editor_and')} close={() => setStaleWarningDismissed(true)} />}
    {stale && dirty && <CopyLibraryDraft editor={draft} />}
    <EditorActions formId={formId} disabled={busy || stale || outputConflict} cancelDisabled={busy} close={close} />
  </form></NumberDraftContext.Provider>;
}
function ConnectionTools({ connection, parameters, connectionId, apiKey, disabled }: { connection: Connection; parameters: ConnectionParameterDraft; connectionId?: string; apiKey?: string; disabled: boolean }) {
  useLocale();
  const [result, setResult] = useState<ConnectionDiagnostic | null>(null), [error, setError] = useTextState('');
  const [testing, setTesting] = useState(false);
  const attempt = useRef(0);
  const signature = JSON.stringify([connection, parameters, connectionId, apiKey]);
  useEffect(() => {
    attempt.current++; setResult(null); setError(''); setTesting(false);
  }, [signature]);
  useEffect(() => () => { attempt.current++; }, []);
  async function diagnose(action: 'check' | 'test', form: HTMLFormElement | null) {
    // Validate the visible draft before using the last parsed numeric values for a test request.
    if (form?.querySelector('[role="tabpanel"] input:invalid') && !form.reportValidity()) return;
    const id = ++attempt.current; setTesting(true); setResult(null); setError('');
    try {
      const input = connectionFromDraft(connection, parameters);
      const value = await api<ConnectionDiagnostic>('/connections/diagnose', 'POST', { action, connection: input, connectionId, apiKey });
      if (attempt.current === id) setResult(value);
    } catch (error) { if (attempt.current === id) setError(errorText(error, msg("libraries.connection_test_failed"))); }
    finally { if (attempt.current === id) setTesting(false); }
  }
  return <section className="settings-section connection-tools">
    <h3>{t('libraries.connection_diagnostics')}</h3>
    <div className="actions"><button type="button" className="secondary" disabled={disabled || testing} onClick={event => void diagnose('check', event.currentTarget.form)}>{t("libraries.check_connection")}</button><button type="button" className="secondary" disabled={disabled || testing} onClick={event => void diagnose('test', event.currentTarget.form)}>{t("libraries.send_test_message")}</button></div>
    <p className="small muted connection-help">{t("libraries.enter_your_provider_s_api_key_above")}</p>
    {testing && <p className="small" role="status">{t("libraries.testing_connection")}</p>}
    {error && <p className="small connection-error" role="alert">{error}</p>}
    {result && <div className="connection-test-result" role="status"><p className="small connection-success">{formatMessage(result.localized ?? result.message)}</p>{result.request && <><p className="small">{result.usage ? t("libraries.token_usage_input_output", { value: result.usage.inputTokens.toLocaleString(locale()), value2: result.usage.outputTokens.toLocaleString(locale()) }) : t("libraries.token_usage_unavailable")}</p><details><summary>{t("libraries.test_request_and_response")}</summary><pre>{JSON.stringify({ request: result.request, response: result.response, usage: result.usage }, null, 2)}</pre></details></>}</div>}
  </section>;
}
function PromptInstruction({ title, label, help, custom, fallback, change }: {
  title: string; label: string; help: string; custom?: string; fallback: string; change: (text: string) => void;
}) {
  useLocale();
  const helpId = useId();
  const [open, setOpen] = useState(false);
  return <details className="editor-disclosure" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>
      <span>
        <span>{title}</span>
        <small className="muted">{t(custom?.trim() ? 'libraries.prompt_instruction_custom' : 'libraries.prompt_instruction_default')}</small>
      </span>
      <Icon name="ArrowShortBottom" />
    </summary>
    {open && <label className="editor-disclosure-content">
      <small id={helpId}>{help}</small>
      <EditorTextarea aria-label={label} aria-describedby={helpId} maxLength={100_000}
        value={custom ?? fallback} onChange={event => change(event.target.value)} />
    </label>}
  </details>;
}

const promptEditorTabs = [
  ['main', 'libraries.main_prompt'],
  ['instructions', 'libraries.action_instructions'],
] as const;
type PromptEditorTab = (typeof promptEditorTabs)[number][0];

function PromptEditor({ value, change }: { value: PromptPreset; change: (value: PromptPreset) => void }) {
  useLocale();
  const id = useId();
  const [activeTab, setActiveTab] = useState<PromptEditorTab>('main');
  return <div className="full prompt-editor">
    <EditorTabs id={id} label={t('libraries.prompt_editor_sections')} tabs={promptEditorTabs}
      active={activeTab} select={setActiveTab} className="prompt-editor-tabs" />
    <WarningMessages messages={promptWarningMessages(value)} />
    <div role="tabpanel" id={`${id}-main-panel`} aria-labelledby={`${id}-main-tab`} hidden={activeTab !== 'main'}
      onInvalid={() => {
        // Reveal invalid block fields before the browser moves focus to the first one.
        if (activeTab !== 'main') flushSync(() => setActiveTab('main'));
      }}>
      <details className="prompt-assembly-help">
        <summary>{t('libraries.how_prompt_assembly_works')}</summary>
        <p className="small muted">{t('libraries.enabled_blocks_and_markers_compose_the_base', { value: '{{user}}', value2: '{{char}}' })}</p>
      </details>
      <PromptBlocks value={value} change={change} />
    </div>
    <div className="prompt-instructions" role="tabpanel" id={`${id}-instructions-panel`}
      aria-labelledby={`${id}-instructions-tab`} hidden={activeTab !== 'instructions'}>
      <PromptInstruction title={t('continue.action')} label={t('continue.instruction')} help={t('continue.instruction_help')}
        custom={value.continuationInstruction} fallback={defaultContinuationInstruction}
        change={continuationInstruction => change({ ...value, continuationInstruction })} />
      <PromptInstruction title={t('libraries.opening_scene')} label={t('opening.instruction')} help={t('opening.instruction_help')}
        custom={value.openingInstruction} fallback={defaultOpeningInstruction}
        change={openingInstruction => change({ ...value, openingInstruction })} />
    </div>
  </div>;
}

function PromptBlocks({ value, change }: { value: PromptPreset; change: (value: PromptPreset) => void }) {
  useLocale();
  const listId = useId();
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(() => new Set());
  function setBlockExpanded(id: string, expanded: boolean) {
    setExpandedBlocks(previous => {
      if (previous.has(id) === expanded) return previous;
      const next = new Set(previous);
      if (expanded) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  const roleOptions = (['system', 'user', 'assistant'] as const).map(role => ({ value: role, label: stateLabel(role) }));
  function update(index: number, block: PromptBlock) { change({ ...value, blocks: value.blocks.map((old, i) => i === index ? block : old) }); }
  function move(from: number, to: number) {
    if (to < 0 || to >= value.blocks.length || from === to) return;
    change({ ...value, blocks: moveListItem(value.blocks, from, to) });
  }
  const reorder = useListReorder(move);
  return <>
  <div className="prompt-blocks" {...reorder.list}>{value.blocks.map((block, index) => {
    const position = index + 1;
    const expanded = expandedBlocks.has(block.id);
    const hasOriginalRoles = block.kind === 'marker' && block.marker === 'messages';
    const roleLabel = hasOriginalRoles ? t('libraries.original_roles') : stateLabel(block.role);
    const blockId = `${listId}-${position}`;
    const disclosureLabel = t(expanded ? 'libraries.collapse_block_number' : 'libraries.expand_block_number', { number: position });
    const toggle = () => setBlockExpanded(block.id, !expanded);
    return <section className={`prompt-block${reorder.rowClass(index, value.blocks.length)}`} aria-label={t('libraries.prompt_block', { value: position })} key={block.id}>
      <div className="block-heading">
        <span {...reorder.handle(index, block.id)} title={t('libraries.drag_to_reorder')} className="drag-handle" aria-label={t('libraries.drag_block', { value: position })}><Icon name="Menu" /></span>
        <label className="block-enabled">
          <input type="checkbox" aria-label={t('libraries.enable_block', { value: position })} checked={block.enabled}
            onChange={event => update(index, { ...block, enabled: event.target.checked })} />
        </label>
        <button type="button" className="quiet block-summary" aria-expanded={expanded} aria-controls={`${blockId}-fields`}
          aria-labelledby={`${blockId}-name ${blockId}-disclosure`} aria-describedby={`${blockId}-role`} onClick={toggle}>
          <span className="block-summary-text">
            <span id={`${blockId}-name`} className="block-summary-name">{block.name.trim() ? block.name : t('libraries.block_name')}</span>
            <span id={`${blockId}-role`} className="small muted">{roleLabel}</span>
          </span>
          <Icon name={expanded ? 'ArrowShortTop' : 'ArrowShortBottom'} />
          <span id={`${blockId}-disclosure`} className="sr-only">{disclosureLabel}</span>
        </button>
        <div className="block-fields" id={`${blockId}-fields`} data-expanded={expanded}>
          <label className="block-name">
            <span className="block-name-label" aria-hidden="true">{t('libraries.block_name')}</span>
            <input required aria-label={t('libraries.block_name')} value={block.name}
              onInvalid={() => {
                // The collapsed name still participates in native form validation.
                if (!expanded) flushSync(() => setBlockExpanded(block.id, true));
              }}
              onChange={event => update(index, { ...block, name: event.target.value })} />
          </label>
          <button type="button" className="quiet block-toggle" aria-expanded={expanded} aria-controls={`${blockId}-content`}
            title={t(expanded ? 'libraries.collapse_block' : 'libraries.expand_block')}
            aria-label={disclosureLabel} onClick={toggle}>
            <Icon name={expanded ? 'ArrowShortTop' : 'ArrowShortBottom'} />
          </button>
          <div className="block-settings">
            <div className="block-role">
              {hasOriginalRoles
                ? <span className="small muted">{roleLabel}</span>
                : <Dropdown aria-label={t('libraries.role_for_block', { value: position })} value={block.role} options={roleOptions} minMenuWidth={176}
                    onChange={selected => {
                      const role = roleOptions.find(option => option.value === selected);
                      if (role) update(index, { ...block, role: role.value });
                    }} />}
            </div>
            <div className="block-actions">
              <button type="button" className="quiet" title={t('libraries.move_up')} aria-label={t('libraries.move_block_up', { value: position })}
                disabled={index === 0} onClick={() => move(index, index - 1)}><Icon name="ArrowLongTop" /></button>
              <button type="button" className="quiet" title={t('libraries.move_down')} aria-label={t('libraries.move_block_down', { value: position })}
                disabled={index === value.blocks.length - 1} onClick={() => move(index, index + 1)}><Icon name="ArrowLongBottom" /></button>
              <button type="button" className="quiet" title={t('libraries.delete_block')} aria-label={t('libraries.remove_block', { value: position })}
                onClick={() => change({ ...value, blocks: value.blocks.filter((_, i) => i !== index) })}><Icon name="TrashOutline" /></button>
            </div>
          </div>
          {expanded && <div className="block-content" id={`${blockId}-content`}>
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
        </div>
      </div>
    </section>;
  })}</div><div className="actions"><button type="button" className="secondary" disabled={value.blocks.length >= 100} onClick={() => change({ ...value, blocks: [...value.blocks, { id: newId(), name: 'Text', enabled: true, kind: 'text', role: 'system', text: '' }] })}>{t("libraries.add_text_block")}</button><button type="button" className="secondary" disabled={value.blocks.length >= 100} onClick={() => change({ ...value, blocks: [...value.blocks, { id: newId(), name: 'Marker', enabled: true, kind: 'marker', role: 'system', marker: 'description' }] })}>{t("libraries.add_marker")}</button></div></>;
}

function MarkerFieldSelection<T extends string>({ label, options, selected, change }: { label: string; options: readonly { value: T; label: string }[]; selected: readonly T[]; change: (selected: T[]) => void }) {
  useLocale();
  return <fieldset className="marker-fields"><legend>{label}</legend><p className="small muted">{t("libraries.checked_fields_become_separate_messages_in_this")}</p><div className="marker-field-options">{options.map(option => <label className="checkbox" key={option.value}><input type="checkbox" checked={selected.includes(option.value)} onChange={event => change(options.filter(candidate => candidate.value === option.value ? event.target.checked : selected.includes(candidate.value)).map(candidate => candidate.value))} />{option.label}</label>)}</div></fieldset>;
}
