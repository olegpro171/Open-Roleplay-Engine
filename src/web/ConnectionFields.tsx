import { useId } from 'react';
import type { ConnectionRecord, DiscoveredModel } from '../shared/contracts';
import type { DraftOf } from './library-draft';
import type { ConnectionField, ConnectionFieldError, ConnectionParameterDraft } from './connection-parameter-draft';
import { ConnectionParameters } from './ConnectionParameters';
import { NumberInput, type useNumberDraft } from './Controls';
import { EditorTabs } from './EditorTabs';
import { EditorFieldError, EditorNameField, revealInvalidField } from './LibraryEditorFields';
import { ModelField } from './ModelPicker';
import { formatMessage, locale, t, useLocale } from './localization';

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
  fieldError?: ConnectionFieldError; clearFieldError: (field: ConnectionField) => void;
};

export function ConnectionFields({ value, change, id, busy, hasApiKey, apiKey, setApiKey, removeKey, setRemoveKey,
  windowSource, setWindowSource, baselineWindow, numberDraft, outputConflict, reportWindow,
  tab, selectTab, parameters, setParameters, fieldError, clearFieldError }: Props) {
  const fieldId = useId();
  useLocale();
  const reportedWindow = value.modelWindowReport?.tokens;
  const matchesReport = reportedWindow !== undefined && value.contextWindow === reportedWindow
    && numberDraft.values.contextWindow === undefined;
  const windowLabel = reportedWindow !== undefined
    ? matchesReport ? 'libraries.context_window_provider' : 'libraries.context_window_manual'
    : !id && !windowSource ? 'libraries.context_window_default' : 'libraries.context_window_unknown';
  const endpointError = fieldError?.field === 'endpoint' ? formatMessage(fieldError.localized) : undefined;
  const keyError = fieldError?.field === 'apiKey' ? formatMessage(fieldError.localized) : undefined;
  const endpointErrorId = `${fieldId}-endpoint-error`;
  const keyErrorId = `${fieldId}-key-error`;

  function replaceContextWindow(next: ConnectionRecord, source?: WindowSource, contextWindow = baselineWindow) {
    numberDraft.set('contextWindow', undefined);
    setWindowSource(source);
    change({ ...next, contextWindow });
  }
  function changeEndpoint(endpoint: string) {
    if (endpoint === value.endpoint) return;
    clearFieldError('endpoint');
    if (fieldError?.localized.key === 'errors.enter_an_api_key_for_the_changed_endpoint') clearFieldError('apiKey');
    const next = { ...value, endpoint, modelWindowReport: undefined };
    if (windowSource === 'provider') replaceContextWindow(next);
    else change(next);
  }
  function selectModel(model: DiscoveredModel) {
    clearFieldError('model');
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
    <EditorNameField name="name" value={value.name} error={fieldError?.field === 'name' ? formatMessage(fieldError.localized) : undefined}
      change={name => { clearFieldError('name'); change({ ...value, name }); }} />
    <EditorTabs id={fieldId} label={t('libraries.connection_editor_sections')} tabs={tabs}
      active={tab} select={selectTab} className="tabs library-editor-tabs" />
    <div id={`${fieldId}-settings-panel`} role="tabpanel" aria-labelledby={`${fieldId}-settings-tab`} hidden={tab !== 'settings'}
      onInvalid={event => revealInvalidField(event, () => selectTab('settings'))}>
      <section className="settings-section">
        <h3>{t('libraries.provider')}</h3>
        <div className="connection-provider-fields">
          <label>{t('libraries.api_base_url')}<input name="endpoint" type="url" required value={value.endpoint}
            aria-label={t('libraries.api_base_url')} aria-invalid={endpointError ? true : undefined}
            aria-describedby={endpointError ? endpointErrorId : undefined} onChange={event => changeEndpoint(event.target.value)} />
            <EditorFieldError id={endpointErrorId} error={endpointError} />
          </label>
          <div className="connection-key-field">
            <label>{t('libraries.api_key')}<input name="apiKey" type="password" autoComplete="new-password" disabled={removeKey}
              aria-label={t('libraries.api_key')} aria-invalid={keyError ? true : undefined} aria-describedby={keyError ? keyErrorId : undefined}
              placeholder={t(hasApiKey ? 'libraries.saved_leave_blank_to_keep_it' : 'libraries.optional_for_endpoints_without_authentication')}
              value={apiKey} onChange={event => { clearFieldError('apiKey'); setApiKey(event.target.value); }} />
              <EditorFieldError id={keyErrorId} error={keyError} />
            </label>
            {hasApiKey && <label className="checkbox"><input type="checkbox" checked={removeKey}
              onChange={event => { clearFieldError('apiKey'); setRemoveKey(event.target.checked); }} />{t('libraries.remove_the_saved_api_key')}</label>}
          </div>
          <ModelField value={value.model} endpoint={value.endpoint} connectionId={id}
            error={fieldError?.field === 'model' ? formatMessage(fieldError.localized) : undefined}
            apiKey={removeKey ? '' : apiKey || undefined} disabled={busy} change={selectModel} reportWindow={reportWindow} />
        </div>
      </section>
      <section className="settings-section">
        <h3>{t('libraries.token_limits')}</h3>
        <div className="connection-setting connection-limits">
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
          <small className="connection-output-status" id={`${fieldId}-output-conflict`} role={conflict ? 'alert' : undefined}>{conflict}</small>
        </div>
      </section>
    </div>
    <div id={`${fieldId}-parameters-panel`} role="tabpanel" aria-labelledby={`${fieldId}-parameters-tab`} hidden={tab !== 'parameters'}>
      {conflict && <p className="small connection-error" role="alert">{conflict}{' '}
        <button type="button" className="text-link" onClick={() => selectTab('settings')}>{t('libraries.connection_settings')}</button>
      </p>}
      <ConnectionParameters draft={parameters} change={setParameters} disabled={busy}
        fieldError={fieldError} clearFieldError={clearFieldError} />
    </div>
  </>;
}
