import { useId } from 'react';
import { numericConnectionParameters, reasoningEffortSchema, stopSequenceLimit, stopSequenceMaxLength, type NumericConnectionParameter } from '../shared/connection-parameters';
import { Icon } from './Icon';
import { Dropdown } from './Controls';
import { EditorTextarea } from './EditorTextarea';
import { t, useLocale } from './localization';
import type { ConnectionParameterDraft } from './connection-parameter-draft';

export function ConnectionParameters({ draft, change, disabled }: {
  draft: ConnectionParameterDraft;
  disabled: boolean;
  change: (draft: ConnectionParameterDraft) => void;
}) {
  useLocale();
  const fieldHelpId = useId();
  const customHelpId = `${fieldHelpId}-custom`;
  const { builtInParameters, parameters } = draft;
  const { numbers, stop, reasoning_effort: reasoningEffort } = builtInParameters;
  function changeBuiltIn(patch: Partial<typeof builtInParameters>) {
    change({ ...draft, builtInParameters: { ...builtInParameters, ...patch } });
  }
  function numericField(key: NumericConnectionParameter, label: string) {
    const { minValue, maxValue } = numericConnectionParameters[key];
    const inputMode = minValue === 0 ? 'decimal' : 'text';
    const help = key === 'temperature' || key === 'top_p'
      ? t(`connection_parameters.${key}_help`, { min: String(minValue), max: String(maxValue) })
      : undefined;
    const helpId = `${fieldHelpId}-${key}`;
    return <label className="library-editor-setting connection-parameter-setting"><span>{label}
      {help && <small className="muted" id={helpId}>{help}</small>}</span>
      <input name={key} aria-label={label} type="text" inputMode={inputMode} aria-describedby={help ? helpId : undefined}
        value={numbers[key] ?? ''} placeholder={t('connection_parameters.provider_default')} onChange={event => {
        const next = { ...numbers };
        if (event.target.value === '') delete next[key];
        else next[key] = event.target.value;
        changeBuiltIn({ numbers: next });
      }} /></label>;
  }
  const stopSequences = Array.isArray(stop) ? stop : stop === undefined ? [] : [stop];
  function changeStop(index: number, value: string) {
    changeBuiltIn({ stop: Array.isArray(stop) ? stop.map((sequence, position) => position === index ? value : sequence) : value });
  }
  function removeStop(index: number) {
    const remaining = stopSequences.filter((_, position) => position !== index);
    changeBuiltIn({ stop: remaining.length ? remaining : undefined });
  }
  return <>
    <section className="settings-section">
      <h3>{t('libraries.sampling')}</h3>
      {numericField('temperature', t('connection_parameters.temperature'))}
      {numericField('top_p', t('connection_parameters.top_p'))}
    </section>
    <details className="editor-disclosure library-editor-disclosure connection-advanced">
      <summary>{t('connection_parameters.advanced')}<Icon name="ArrowShortBottom" /></summary>
      <div className="connection-advanced-fields">
        {numericField('presence_penalty', t('connection_parameters.presence_penalty'))}
        {numericField('frequency_penalty', t('connection_parameters.frequency_penalty'))}
        {numericField('seed', t('connection_parameters.seed'))}
        <label className="library-editor-setting connection-parameter-setting">{t('connection_parameters.reasoning_effort')}
          <Dropdown aria-label={t('connection_parameters.reasoning_effort')} disabled={disabled} value={reasoningEffort ?? ''} onChange={value => {
            const choice = reasoningEffortSchema.safeParse(value);
            changeBuiltIn({ reasoning_effort: choice.success ? choice.data : undefined });
          }} options={[
            { value: '', label: t('connection_parameters.provider_default') },
            ...reasoningEffortSchema.options.map(effort => ({ value: effort, label: effort })),
          ]} />
        </label>
        {stopSequences.map((sequence, index) => <div className="connection-stop-field" key={index}>
          <label>{t('connection_parameters.stop_sequence', { number: index + 1 })}
            <EditorTextarea className="connection-stop-sequence" rows={2} maxLength={stopSequenceMaxLength} value={sequence} onChange={event => changeStop(index, event.target.value)} />
          </label>
          <div className="actions">
            <button type="button" className="text-link" aria-label={t('connection_parameters.remove_stop', { number: index + 1 })}
              onClick={() => removeStop(index)}>{t('connection_parameters.remove')}</button>
          </div>
        </div>)}
        <div className="actions">
          {stopSequences.length < stopSequenceLimit && <button type="button" className="secondary"
            onClick={() => changeBuiltIn({ stop: stop === undefined ? '' : [...stopSequences, ''] })}>{t('connection_parameters.add_stop')}</button>}
          {Array.isArray(stop) && stop.length === 0 && <button type="button" className="secondary"
            onClick={() => changeBuiltIn({ stop: undefined })}>{t('connection_parameters.reset_stop')}</button>}
        </div>
        <div>
          <label>{t('libraries.custom_request_parameters')}
            <EditorTextarea name="customParameters" className="code-input" aria-describedby={customHelpId} value={parameters} onChange={event => change({ ...draft, parameters: event.target.value })} />
          </label>
          <small id={customHelpId} className="field-help muted">{t('connection_parameters.custom_help')}</small>
        </div>
      </div>
    </details>
  </>;
}
