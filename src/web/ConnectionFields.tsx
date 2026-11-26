import { useId } from 'react';
import type { ConnectionRecord, DiscoveredModel } from '../shared/contracts';
import type { DraftOf } from './library-draft';
import type { ConnectionParameterDraft } from './connection-parameter-draft';
import { ConnectionParameters } from './ConnectionParameters';
import { NumberInput, type useNumberDraft } from './Controls';
import { EditorTabs } from './EditorTabs';
import { EditorNameField, revealInvalidField } from './LibraryEditorFields';
import { ModelField } from './ModelPicker';
import { locale, t, useLocale } from './localization';

const tabs = [['settings', 'libraries.connection_settings'], ['parameters', 'libraries.request_parameters']] as const;
export type ConnectionTab = (typeof tabs)[number][0];
type WindowSource = DraftOf<'connections'>['contextWindowSource'];

type Props = {
  value: ConnectionRecord; change: (value: ConnectionRecord) => void; id?: string; busy: boolean;
  hasApiKey?: boolean; apiKey: string; setApiKey: (key: string) => void;
  removeKey: boolean; setRemoveKey: (remove: boolean) => void;
  windowSource: WindowSource; setWindowSource: (source: WindowSource) => void; baselineWindow: number;
  numberDraft: ReturnType<typeof useNumberDraft>; outputConflict: boolean;
  reportWindow: (endpoint: string, model: DiscoveredModel) => void;
  tab: ConnectionTab; selectTab: (tab: ConnectionTab) => void;
  parameters: ConnectionParameterDraft; setParameters: (value: ConnectionParameterDraft) => void;
};

export function ConnectionFields({ value, change, id, busy, hasApiKey, apiKey, setApiKey, removeKey, setRemoveKey,
  windowSource, setWindowSource, baselineWindow, numberDraft, outputConflict, reportWindow,
  tab, selectTab, parameters, setParameters }: Props) {
  const fieldId = useId();
  useLocale();
  const reportedWindow = value.modelWindowReport?.tokens;
  const matchesReport = reportedWindow !== undefined && value.contextWindow === reportedWindow
    && numberDraft.values.contextWindow === undefined;
  const windowLabel = reportedWindow !== undefined
    ? matchesReport ? 'libraries.context_window_provider' : 'libraries.context_window_manual'
    : !id && !windowSource ? 'libraries.context_window_default' : 'libraries.context_window_unknown';

  function replaceContextWindow(next: ConnectionRecord, source?: WindowSource, contextWindow = baselineWindow) {
    numberDraft.set('contextWindow', undefined);
    setWindowSource(source);
    change({ ...next, contextWindow });
  }
  function changeEndpoint(endpoint: string) {
    if (endpoint === value.endpoint) return;
    const next = { ...value, endpoint, modelWindowReport: undefined };
    if (windowSource === 'provider') replaceContextWindow(next);
    else change(next);
  }
  function selectModel(model: DiscoveredModel) {
    const modelChanged = model.id !== value.model;
    const modelWindowReport = model.contextWindow !== undefined
      ? { endpoint: value.endpoint, model: model.id, tokens: model.contextWindow }
      : modelChanged ? undefined : value.modelWindowReport;
    const next = { ...value, model: model.id, modelWindowReport };
    if (!id && model.contextWindow !== undefined && (modelChanged || windowSource !== 'manual')) {
      replaceContextWindow(next, 'provider', model.contextWindow);
    } else if (modelChanged && windowSource === 'provider') {
      replaceContextWindow(next);
    } else {
      change(next);
    }
  }
  const conflict = outputConflict && (value.contextWindow === 1 ? t('libraries.context_window_too_small')
    : t('libraries.context_window_output_conflict', { tokens: value.contextWindow.toLocaleString(locale()) }));
  return <>
    <div className="library-editor-identity">
      <EditorNameField value={value.name} change={name => change({ ...value, name })} />
      <ModelField value={value.model} endpoint={value.endpoint} connectionId={id}
        apiKey={removeKey ? '' : apiKey || undefined} disabled={busy} change={selectModel} reportWindow={reportWindow} />
    </div>
    <EditorTabs id={fieldId} label={t('libraries.connection_editor_sections')} tabs={tabs}
      active={tab} select={selectTab} className="tabs library-editor-tabs" />
    <div id={`${fieldId}-settings-panel`} role="tabpanel" aria-labelledby={`${fieldId}-settings-tab`} hidden={tab !== 'settings'}
      onInvalid={event => revealInvalidField(event, () => selectTab('settings'))}>
      <section className="settings-section">
        <h3>{t('libraries.provider')}</h3>
        <div className="connection-provider-fields">
          <label>{t('libraries.api_base_url')}<input type="url" required value={value.endpoint}
            onChange={event => changeEndpoint(event.target.value)} /></label>
          <div className="connection-key-field">
            <label>{t('libraries.api_key')}<input type="password" autoComplete="new-password" disabled={removeKey}
              placeholder={t(hasApiKey ? 'libraries.saved_leave_blank_to_keep_it' : 'libraries.optional_for_endpoints_without_authentication')}
              value={apiKey} onChange={event => setApiKey(event.target.value)} /></label>
            {hasApiKey && <label className="checkbox"><input type="checkbox" checked={removeKey}
              onChange={event => setRemoveKey(event.target.checked)} />{t('libraries.remove_the_saved_api_key')}</label>}
          </div>
        </div>
      </section>
      <section className="settings-section">
        <h3>{t('libraries.token_limits')}</h3>
        <div className="connection-limits">
          <label htmlFor={`${fieldId}-window`}>{t('libraries.model_context_window')}</label>
          <NumberInput id={`${fieldId}-window`} draftField="contextWindow" required value={value.contextWindow}
            aria-describedby={value.model ? `${fieldId}-window-source` : undefined} onEdit={() => setWindowSource('manual')}
            onChange={contextWindow => change({ ...value, contextWindow })} />
          <div className="connection-window-status">
            {value.model && <small className="muted" id={`${fieldId}-window-source`}>{t(windowLabel)}</small>}
            {reportedWindow !== undefined && !matchesReport && <button type="button" className="text-link"
              title={t('libraries.context_window_apply_reported')} onClick={() => replaceContextWindow(value, 'provider', reportedWindow)}>
              {t('libraries.context_window_restore', { tokens: reportedWindow.toLocaleString(locale()) })}
            </button>}
          </div>
          <label htmlFor={`${fieldId}-reserve`}>{t('libraries.reserved_output_tokens')}</label>
          <NumberInput id={`${fieldId}-reserve`} draftField="maxOutputTokens" required max={1_000_000} value={value.maxOutputTokens}
            aria-invalid={outputConflict || undefined} aria-describedby={outputConflict ? `${fieldId}-output-conflict` : undefined}
            onChange={maxOutputTokens => change({ ...value, maxOutputTokens })} />
          <small className="connection-output-status" id={`${fieldId}-output-conflict`} role="alert">{conflict}</small>
        </div>
      </section>
    </div>
    <div id={`${fieldId}-parameters-panel`} role="tabpanel" aria-labelledby={`${fieldId}-parameters-tab`} hidden={tab !== 'parameters'}>
      {conflict && <p className="small connection-error" role="alert">{conflict}{' '}
        <button type="button" className="text-link" onClick={() => selectTab('settings')}>{t('libraries.connection_settings')}</button>
      </p>}
      <ConnectionParameters draft={parameters} change={setParameters} disabled={busy} />
    </div>
  </>;
}
