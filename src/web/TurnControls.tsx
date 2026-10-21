import { t, useLocale } from './localization';
import type { Turn } from '../shared/contracts';
import { Reasoning, type ReasoningProps } from './Reasoning';
import { ResponseVariants } from './ResponseVariants';
import { TurnActionButton } from './TurnActionButton';

export function TurnControls({ turn, locked, editing, inputVisible, action, reasoning, select, edit, remove }: {
  turn: Turn;
  locked: boolean;
  editing: boolean;
  inputVisible: boolean;
  action: { kind: 'regenerate' | 'cancel'; disabled: boolean; run: () => void } | null;
  reasoning: ReasoningProps | null;
  select: (id: string) => Promise<boolean>;
  edit: (part: 'user' | 'assistant') => void;
  remove: () => void;
}) {
  useLocale();
  return <div className="turn-controls" role="group" aria-label={t("turn_controls.turn_controls")}>
    <ResponseVariants turn={turn} locked={locked || editing} select={select} />
    <div className="turn-actions">
      {action && <TurnActionButton action={action.kind} label={action.kind === 'cancel' ? t("character_import.cancel") : t("turn_controls.regenerate_response")} disabled={action.disabled} onClick={action.run} />}
      {inputVisible && <TurnActionButton action="input" label={t("turn_controls.edit_input")} disabled={locked} onClick={() => edit('user')} />}
      <TurnActionButton action="response" label={t("turn_controls.edit_response")} disabled={locked || !turn.complete} onClick={() => edit('assistant')} />
      {reasoning && <Reasoning key={reasoning.generationId} {...reasoning} />}
      <TurnActionButton action="delete" label={t("app.delete_turn_2")} disabled={locked} onClick={remove} />
    </div>
  </div>;
}
