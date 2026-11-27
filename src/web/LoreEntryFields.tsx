import { useContext, useId, useLayoutEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { lorePlacements, type LoreEntry } from '../shared/lorebook';
import { validationMessage } from '../shared/localization-validation';
import { Dropdown, NumberDraftContext, NumberInput } from './Controls';
import { EditorTextarea } from './EditorTextarea';
import { Icon } from './Icon';
import { placementLabel, stateLabel } from './localization-labels';
import { formatMessage, t, useLocale } from './localization';

export const entryNumberFields = ['priority', 'depth', 'scanDepth'] as const;
type EntryNumberField = typeof entryNumberFields[number];

export function entryNumberKey(id: string, field: EntryNumberField) {
  return `entry.${id}.${field}`;
}

function validPriority(value: string) {
  return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value) && Number.isFinite(Number(value));
}

function parseEntryKeys(text: string, useRegex: boolean): string[] {
  // Commas and surrounding spaces can be meaningful inside a regex pattern.
  if (useRegex) return text.split('\n').filter(Boolean);
  return text.split(/[,\r\n]/).map(key => key.trim()).filter(Boolean);
}

export function LoreEntryFields({ entry, update, issues }: { entry: LoreEntry; update: (patch: Partial<LoreEntry>) => void; issues: z.core.$ZodIssue[] }) {
  useLocale();
  const historyHelp = useId();
  const numberDraft = useContext(NumberDraftContext);
  const [priority, setPriority] = useState(numberDraft?.values[entryNumberKey(entry.id, 'priority')] ?? String(entry.priority));
  const priorityInput = useRef<HTMLInputElement>(null);
  const priorityError = priority && !validPriority(priority) ? t('lorebook_editor.invalid_priority') : '';
  useLayoutEffect(() => { priorityInput.current?.setCustomValidity(priorityError); }, [priorityError]);
  const [keys, setKeys] = useState(entry.keys.join('\n')), [secondary, setSecondary] = useState(entry.secondaryKeys.join('\n'));
  function errors(field: string) { return issues.filter(issue => issue.path[2] === field).map((issue, index) => <small role="alert" key={index}>{formatMessage(validationMessage(issue))}</small>); }
  return <>
    <div className="form-grid lore-entry-writing">
      <label className="full">{t("lorebook_editor.entry_name")}<input maxLength={200} value={entry.name} onChange={event => update({ name: event.target.value })} />{errors('name')}</label>
      <label className="checkbox"><input type="checkbox" checked={entry.enabled} onChange={event => update({ enabled: event.target.checked })} />{t("lorebook_editor.entry_enabled")}</label>
      <label className="full">{t("lorebook_editor.lore_content")}<EditorTextarea aria-label={t("lorebook_editor.lore_content")} className="lore-content" maxLength={100_000} value={entry.content} onChange={event => update({ content: event.target.value })} /><small>{t("lorebook_editor.inserted_prose_supports_and_v3_decorator_lines", { value: '{{user}}', value2: '{{char}}' })}</small>{errors('content')}</label>
    </div>
    <details className="editor-disclosure library-editor-disclosure" open>
      <summary>{t('lorebook_editor.activation')}<Icon name="ArrowShortBottom" /></summary>
      <div className="form-grid lore-section-fields">
        <label className="checkbox"><input type="checkbox" checked={entry.constant} onChange={event => update({ constant: event.target.checked })} />{t("lorebook_editor.constant_activation")}</label>
        <label className="checkbox"><input type="checkbox" checked={entry.caseSensitive} onChange={event => update({ caseSensitive: event.target.checked })} />{t("lorebook_editor.case_sensitive_matching")}</label>
        <label className="checkbox"><input type="checkbox" checked={entry.useRegex} onChange={event => {
          // Keep the existing key boundaries when changing how those keys match.
          setKeys(entry.keys.join('\n'));
          setSecondary(entry.secondaryKeys.join('\n'));
          update({ useRegex: event.target.checked });
        }} />{t("lorebook_editor.use_regular_expressions")}</label>
        <label className="full">{t("lorebook_editor.primary_keys")}<EditorTextarea aria-label={t("lorebook_editor.primary_keys")} value={keys} onChange={event => { setKeys(event.target.value); update({ keys: parseEntryKeys(event.target.value, entry.useRegex) }); }} /><small>{t(entry.useRegex ? 'lorebook_editor.regex_keys_help' : 'lorebook_editor.one_key_per_line_at_least_one')}</small>{errors('keys')}</label>
        <label className="full">{t("lorebook_editor.secondary_keys")}<EditorTextarea aria-label={t("lorebook_editor.secondary_keys")} value={secondary} onChange={event => { setSecondary(event.target.value); update({ secondaryKeys: parseEntryKeys(event.target.value, entry.useRegex) }); }} /><small>{t(entry.useRegex ? 'lorebook_editor.regex_secondary_help' : 'lorebook_editor.one_key_per_line_secondary_matching_additionally')}</small>{errors('secondaryKeys')}</label>
        <label className="checkbox full"><input type="checkbox" checked={entry.selective} onChange={event => update({ selective: event.target.checked })} />{t("lorebook_editor.require_a_secondary_key_match")}</label>
        <label className="checkbox full"><input type="checkbox" checked={entry.scanDepth !== null} onChange={event => {
          if (!event.target.checked) numberDraft?.set(entryNumberKey(entry.id, 'scanDepth'), undefined);
          update({ scanDepth: event.target.checked ? 4 : null });
        }} />{t("lorebook_editor.override_the_book_scan_depth")}</label>
        {entry.scanDepth !== null && <label className="library-editor-setting full"><span>{t("lorebook_editor.entry_scan_depth")}</span><NumberInput draftField={entryNumberKey(entry.id, 'scanDepth')} required min={0} max={1000} value={entry.scanDepth} onChange={scanDepth => update({ scanDepth })} />{errors('scanDepth')}</label>}
      </div>
    </details>
    <details className="editor-disclosure library-editor-disclosure">
      <summary>{t('lorebook_editor.insertion')}<Icon name="ArrowShortBottom" /></summary>
      <div className="form-grid lore-section-fields">
        <label className="library-editor-setting full"><span>{t("lorebook_editor.admission_priority")}</span><input ref={priorityInput} required type="text" inputMode="decimal" value={priority}
          onChange={event => {
            const text = event.target.value;
            setPriority(text);
            const valid = validPriority(text);
            numberDraft?.set(entryNumberKey(entry.id, 'priority'), valid ? undefined : text);
            if (valid) update({ priority: Number(text) });
          }} />{errors('priority')}</label>
        <label>{t("lorebook_editor.placement")}<Dropdown aria-label={t("lorebook_editor.lore_entry_placement")} value={entry.placement} options={lorePlacements.map(value => ({ value, label: placementLabel(value) }))} onChange={placement => {
          const parsed = lorePlacements.find(value => value === placement);
          if (!parsed) return;
          if (parsed !== 'history') numberDraft?.set(entryNumberKey(entry.id, 'depth'), undefined);
          update({ placement: parsed });
        }} /></label>
        <label>{t("lorebook_editor.message_role")}<Dropdown aria-label={t("lorebook_editor.lore_entry_role")} value={entry.role ?? ''} options={[{ value: '', label: t("lorebook_editor.use_prompt_control_role") }, ...['system', 'user', 'assistant'].map(role => ({ value: role, label: stateLabel(role === 'system' || role === 'user' ? role : 'assistant') }))]} onChange={role => { if (role === '' || role === 'system' || role === 'user' || role === 'assistant') update({ role: role || null }); }} /></label>
        {entry.placement === 'history' && <div className="full">
          <label className="library-editor-setting"><span>{t('lorebook_editor.history_depth')}</span>
            <NumberInput draftField={entryNumberKey(entry.id, 'depth')} aria-describedby={historyHelp} required min={0} max={1000}
              value={entry.depth} onChange={depth => update({ depth })} />{errors('depth')}</label>
          <small className="muted" id={historyHelp}>{t('lorebook_editor.0_is_after_the_newest_outgoing_message')}</small>
        </div>}
        <p className="small muted full">{t('lorebook_editor.higher_priority_is_admitted_first_equal_priorities')}</p>
      </div>
    </details>
    <details className="editor-disclosure library-editor-disclosure">
      <summary>{t('lorebook_editor.entry_comment')}<Icon name="ArrowShortBottom" /></summary>
      <div className="lore-section-fields"><EditorTextarea aria-label={t('lorebook_editor.entry_comment')} maxLength={100_000} value={entry.comment}
        onChange={event => update({ comment: event.target.value })} /><small>{t('lorebook_editor.for_you_never_inserted_into_the_prompt')}</small>{errors('comment')}</div>
    </details>
  </>;
}
