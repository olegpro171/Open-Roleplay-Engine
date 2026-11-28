import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { StorySnapshot } from '../shared/transcript';
import type { LibraryKind, LibrarySnapshot, selectionsSchema } from '../shared/library';
import type { PromptDiagnostic } from '../shared/prompt-diagnostics';
import { api } from './api';
import { characterDropdownOptions, personaDropdownOptions } from './ChatParticipants';
import { ChatWorkspace } from './ChatWorkspace';
import { Dropdown, NumberDraftContext, NumberInput, useNumberDraft } from './Controls';
import { useWarnOnEditorLeave, type useEditorLeaveGuard } from './EditorLeaveGuard';
import { Icon } from './Icon';
import type { LibraryTarget } from './Libraries';
import { sameDraftValue } from './library-draft';
import { sortLibraryRecords } from './library-sorting';
import { errorText, formatMessage, locale, message as msg, t, useLocale, type MessageText } from './localization';
import { saveMemoryCleanupCopy, useMemoryCleanup } from './MemoryCleanupReview';
import { WarningDetails } from './WarningDialog';

type Selection = ReturnType<typeof selectionsSchema.parse>;
type SelectionKey = Exclude<keyof Selection, 'title' | 'targetInputTokens'>;
type SavedInput = { tokens: number } | { status: string };

function selection(snapshot: StorySnapshot): Selection {
  const settings = snapshot.settings;
  return {
    title: settings.title,
    targetInputTokens: settings.targetInputTokens,
    connectionId: settings.connectionId ?? null,
    promptId: settings.promptId ?? 'default',
    characterId: settings.characterId ?? null,
    personaId: settings.personaId ?? null,
    contextPresetId: settings.contextPresetId ?? null,
    lorebookId: settings.lorebookId ?? null,
  };
}

function libraryDropdownOptions(library: LibrarySnapshot, kind: Exclude<LibraryKind, 'characters' | 'personas'>) {
  const records: readonly { id: string; name: string }[] = library[kind];
  const sorted = sortLibraryRecords(records, kind, library.dates);
  return [
    ...(kind === 'prompts' ? [] : [{ value: '', label: t('character_editor.none_selected') }]),
    ...sorted.map(record => ({ value: record.id, label: record.name })),
  ];
}

export function ChatSetup({ snapshot, library, busy, working, run, sidebar, savedInput, returnToChat, openLibraryItem, addConnection, leaveGuard }: {
  snapshot: StorySnapshot;
  library: LibrarySnapshot;
  busy: boolean;
  working: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  sidebar: ReactNode;
  savedInput: SavedInput;
  addConnection: () => void;
  returnToChat: () => void;
  openLibraryItem: (target: LibraryTarget) => void;
  leaveGuard: ReturnType<typeof useEditorLeaveGuard>;
}) {
  useLocale();
  const [baseline] = useState(() => selection(snapshot));
  const [value, setValue] = useState(baseline);
  const [revision] = useState(snapshot.revision);
  const numberDraft = useNumberDraft();
  const dirty = numberDraft.dirty || !sameDraftValue(value, baseline);
  useWarnOnEditorLeave(leaveGuard, dirty);
  const reviewMemoryCleanup = useMemoryCleanup(run, snapshot.id);
  const warningTrigger = useRef<HTMLButtonElement>(null);
  const [diagnosticsRetry, setDiagnosticsRetry] = useState(0);
  const diagnosticsKey = JSON.stringify([snapshot.id, snapshot.revision, library.revision, value.promptId, value.characterId, value.personaId, value.lorebookId, diagnosticsRetry]);
  const [draftDiagnostics, setDiagnostics] = useState<{ key: string; warnings: PromptDiagnostic[]; error?: MessageText } | null>(null);
  const saved = selection(snapshot);
  const useSavedDiagnostics = saved.promptId === value.promptId
    && saved.characterId === value.characterId && saved.personaId === value.personaId && saved.lorebookId === value.lorebookId;
  const diagnostics = useSavedDiagnostics ? { key: diagnosticsKey, warnings: snapshot.promptDiagnostics } : draftDiagnostics;
  useEffect(() => {
    if (useSavedDiagnostics) return;
    const controller = new AbortController();
    const settings = { ...saved, promptId: value.promptId, characterId: value.characterId, personaId: value.personaId, lorebookId: value.lorebookId };
    void api<PromptDiagnostic[]>(`/chats/${snapshot.id}/prompt-diagnostics`, 'POST', { revision: snapshot.revision, settings }, controller.signal).then(warnings => {
      if (!controller.signal.aborted) setDiagnostics({ key: diagnosticsKey, warnings });
    }).catch(error => {
      if (!controller.signal.aborted) setDiagnostics({ key: diagnosticsKey, warnings: [], error: errorText(error, msg('libraries.could_not_check_prompt_configuration')) });
    });
    return () => controller.abort();
  }, [snapshot.id, snapshot.revision, diagnosticsKey, useSavedDiagnostics]);
  const formId = useId();
  const mounted = useRef(true);
  const submitting = useRef(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const leavingDisabled = busy || saving;
  const fieldsDisabled = leavingDisabled || working;
  const saveDisabled = fieldsDisabled || revision !== snapshot.revision;
  const leaveForStory = (returnFocus?: HTMLElement) => leaveGuard.leave(returnToChat, { returnFocus });
  const model = library.connections.find(connection => connection.id === value.connectionId)?.model;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saveDisabled || submitting.current) return;
    submitting.current = true;
    setSaving(true);
    try {
      const commit = (memoryImpactToken?: string) => api(`/chats/${snapshot.id}/selections`, 'PUT', { revision, settings: value, memoryImpactToken });
      if (value.contextPresetId !== (snapshot.settings.contextPresetId ?? null)) {
        await reviewMemoryCleanup({
          path: `/chats/${snapshot.id}/settings/memory-impact`, body: { revision, contextPresetId: value.contextPresetId },
          copy: saveMemoryCleanupCopy(), commit, saved: returnToChat,
        });
      } else if (await run(() => commit()) && mounted.current) returnToChat();
    } finally {
      submitting.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  function selector(key: SelectionKey, label: string, options: ReturnType<typeof libraryDropdownOptions>, describedBy?: string) {
    return <label>{label}<Dropdown aria-label={label} aria-describedby={describedBy} disabled={fieldsDisabled} value={value[key] ?? ''} onChange={selected => {
      setValue(previous => ({ ...previous, [key]: key === 'promptId' ? selected : selected || null }));
    }} options={options} /></label>;
  }

  const diagnosticsLabel = t('libraries.prompt_configuration_warnings');
  const promptWarnings = diagnostics?.key !== diagnosticsKey || diagnostics.error
    ? <section className="chat-settings-diagnostics" aria-label={diagnosticsLabel}>
        {diagnostics?.key !== diagnosticsKey ? <p className="muted" role="status">{t('libraries.checking_prompt_configuration')}</p> : <>
          <p role="alert">{formatMessage(diagnostics.error)}</p>
          <button type="button" className="secondary" onClick={() => setDiagnosticsRetry(value => value + 1)}>{t('libraries.check_again')}</button>
        </>}
      </section>
    : diagnostics.warnings.length > 0 && <WarningDetails key={diagnosticsKey} triggerRef={warningTrigger} label={diagnosticsLabel} title={diagnosticsLabel}>{close => (
        <ul className="warning-messages">{diagnostics.warnings.map(warning => <li key={warning.code}>
          <p>{formatMessage(warning.localized ?? warning.message)}</p>
          <button type="button" className="secondary" disabled={leavingDisabled} onClick={() => {
            close();
            leaveGuard.leave(() => openLibraryItem({ kind: warning.target, id: warning.itemId }), { returnFocus: warningTrigger.current ?? undefined });
          }}>
            <Icon name="EditOutline" />{t('libraries.edit', { value: warning.target === 'prompts' ? t('interface.prompt_preset') : warning.target === 'characters' ? t('app.character') : t('libraries.lorebook') })}
          </button>
        </li>)}</ul>
      )}</WarningDetails>;

  return <ChatWorkspace sidebar={sidebar} returnToChat={leavingDisabled ? undefined : () => leaveForStory()} actions={<>
    <button type="submit" form={formId} disabled={saveDisabled} aria-label={t('libraries.save_and_return')} title={t('libraries.save_and_return')}><Icon name="SaveOutline" /><span>{t('libraries.save_and_return')}</span></button>
    <button type="button" className="secondary" disabled={leavingDisabled} onClick={event => leaveForStory(event.currentTarget)} aria-label={t('libraries.return_without_saving')} title={t('libraries.return_without_saving')}><Icon name="Close" /><span>{t('libraries.return_without_saving')}</span></button>
  </>}>
    <section className="document-panel chat-panel chat-settings-panel" aria-labelledby={`${formId}-heading`}>
      <h1 id={`${formId}-heading`}>{t('app.chat_settings')}</h1>
      <div className="chat-settings-meta small muted">
        <p>{t('chat_setup.scope', { title: snapshot.settings.title })}</p>
        <p role="status">{dirty ? t('chat_setup.unsaved_changes') : ''}</p>
      </div>
      <form id={formId} onSubmit={save}>
        {revision !== snapshot.revision && <p role="status">{t('libraries.this_chat_changed_reopen_chat_settings_to')}</p>}
        <section className="chat-settings-group" aria-labelledby={`${formId}-story`}>
          <h2 id={`${formId}-story`}>{t('app.story')}</h2>
          <div className="form-grid">
            <label>{t('libraries.chat_title')}<input required disabled={fieldsDisabled} maxLength={100} value={value.title} onChange={event => setValue({ ...value, title: event.target.value })} /></label>
            {selector('lorebookId', t('libraries.lorebook'), libraryDropdownOptions(library, 'lorebooks'))}
            {selector('characterId', t('app.character'), characterDropdownOptions(library))}
            {selector('personaId', t('libraries.persona'), personaDropdownOptions(library))}
          </div>
        </section>
        <section className="chat-settings-group" aria-labelledby={`${formId}-generation`}>
          <h2 id={`${formId}-generation`}>{t('chat_setup.generation')}</h2>
          <div className="form-grid">
            <div className="chat-settings-field">
              {selector('connectionId', t('libraries.connection'), libraryDropdownOptions(library, 'connections'), model ? `${formId}-model` : undefined)}
              {model && <small id={`${formId}-model`} className="muted">{t('chat_setup.model', { model })}</small>}
              {library.connections.length === 0 && <button type="button" className="secondary" disabled={fieldsDisabled} onClick={event => {
                leaveGuard.leave(addConnection, { returnFocus: event.currentTarget });
              }}>{t('story_home.add_connection')}</button>}
            </div>
            <div className="chat-settings-field">
              {selector('promptId', t('libraries.prompt_preset'), libraryDropdownOptions(library, 'prompts'))}
              {promptWarnings}
            </div>
          </div>
        </section>
        <section className="chat-settings-group" aria-labelledby={`${formId}-context`}>
          <h2 id={`${formId}-context`}>{t('chat_setup.context')}</h2>
          <div className="form-grid">
            {selector('contextPresetId', t('libraries.context_preset'), libraryDropdownOptions(library, 'contexts'))}
            <div className="chat-settings-field">
              <label>{t('libraries.target_input_tokens')}
                <NumberDraftContext.Provider value={numberDraft}>
                  <NumberInput draftField="targetInputTokens" required disabled={fieldsDisabled} aria-describedby={`${formId}-estimate`} value={value.targetInputTokens}
                    onChange={targetInputTokens => setValue({ ...value, targetInputTokens })} />
                </NumberDraftContext.Provider>
              </label>
              <small id={`${formId}-estimate`} className="muted">{'tokens' in savedInput
                ? t('chat_setup.saved_input_estimate', { tokens: savedInput.tokens.toLocaleString(locale()) })
                : savedInput.status}</small>
            </div>
          </div>
        </section>
      </form>
    </section>
  </ChatWorkspace>;
}
