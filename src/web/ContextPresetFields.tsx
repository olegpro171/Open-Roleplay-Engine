import { useId, useState } from 'react';
import { EditorNameField, revealInvalidField } from './LibraryEditorFields';
import type { ContextPreset } from '../shared/context';
import type { Connection } from '../shared/contracts';
import type { Saved } from '../shared/library';
import { Dropdown, NumberInput } from './Controls';
import { EditorTabs } from './EditorTabs';
import { Icon } from './Icon';
import { t, useLocale } from './localization';

const tabs = [['memory', 'libraries.memory_settings'], ['prompts', 'labels.library.prompts']] as const;
type ContextTab = (typeof tabs)[number][0];
const groups = [
  { title: 'libraries.turns_and_summaries', fields: [
    ['minTail', 'libraries.minimum_verbatim_turns', 'libraries.minimum_verbatim_help', 0],
    ['batchSize', 'libraries.turns_per_batch', 'libraries.turn_batch_help', 1],
    ['summaryTokens', 'libraries.requested_summary_tokens', 'libraries.summary_target_help', 1],
  ] },
  { title: 'libraries.combining_summaries', fields: [
    ['promotionGroup', 'libraries.summaries_per_promotion', 'libraries.promotion_group_help', 2],
    ['retainedPerLevel', 'libraries.retain_summaries_per_level', 'libraries.retain_per_level_help', 0],
  ] },
] as const;
const prompts = [
  ['extractionPrompt', 'libraries.extraction_heading', 'libraries.first_layer_extraction_prompt', 'libraries.extraction_help'],
  ['promotionPrompt', 'libraries.combining_summaries', 'libraries.higher_layer_compression_prompt', 'libraries.compression_help'],
  ['repairPrompt', 'libraries.repair_heading', 'libraries.repair_prompt', 'libraries.repair_receives_the_existing_summary_and_before'],
] as const;

export function ContextPresetFields({ value, change, connections }: {
  value: ContextPreset; change: (value: ContextPreset) => void; connections: Saved<Connection>[];
}) {
  useLocale();
  const id = useId();
  const [active, select] = useState<ContextTab>('memory');

  return <>
    <div className="library-editor-identity">
      <EditorNameField value={value.name} change={name => change({ ...value, name })} />
      <label>{t('libraries.summarization_connection')}
        <Dropdown fadeLabel aria-label={t('libraries.summarization_connection')} value={value.connectionId ?? ''}
          onChange={connectionId => change({ ...value, connectionId: connectionId || null })}
          options={[{ value: '', label: t('libraries.same_as_current_chat_connection') },
            ...connections.map(connection => ({ value: connection.id, label: `${connection.name} · ${connection.model}` }))]} />
      </label>
    </div>
    <EditorTabs id={id} label={t('libraries.context_editor_sections')} tabs={tabs} active={active} select={select} className="tabs library-editor-tabs" />
    <div id={`${id}-memory-panel`} role="tabpanel" aria-labelledby={`${id}-memory-tab`} hidden={active !== 'memory'}
      onInvalid={event => revealInvalidField(event, () => select('memory'))}>
      {groups.map(group => <section className="settings-section" key={group.title}>
        <h3>{t(group.title)}</h3>
        {group.fields.map(([field, label, help, min]) => <label className="library-editor-setting" key={field}>
          <span>{t(label)}<small className="muted" id={`${id}-${field}-help`}>{t(help)}</small></span>
          <NumberInput aria-label={t(label)} aria-describedby={`${id}-${field}-help`} draftField={field}
            required min={min} max={field === 'summaryTokens' ? 1_000_000 : 50_000} value={value[field]}
            onChange={number => change({ ...value, [field]: number })} />
        </label>)}
      </section>)}
    </div>
    <div id={`${id}-prompts-panel`} role="tabpanel" aria-labelledby={`${id}-prompts-tab`} hidden={active !== 'prompts'}
      onInvalid={event => revealInvalidField(event, () => select('prompts'))}>
      {prompts.map(([field, heading, label, help]) => <details key={field} className="editor-disclosure library-editor-disclosure" open={field === 'extractionPrompt'}>
        <summary>{t(heading)}<Icon name="ArrowShortBottom" /></summary>
        <div className="context-preset-prompt-body">
          <p id={`${id}-${field}-help`} className="small muted">{t(help)}</p>
          <textarea required aria-label={t(label)} aria-describedby={`${id}-${field}-help`} value={value[field]}
            maxLength={100_000} onChange={event => change({ ...value, [field]: event.target.value })} />
        </div>
      </details>)}
      <p className="small muted context-preset-variables">{t('libraries.context_prompt_variables', {
        tokens: '{{target_tokens}}', level: '{{level}}', user: '{{user}}', character: '{{char}}',
      })}</p>
    </div>
  </>;
}
