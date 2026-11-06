import { useState } from 'react';
import { t, useLocale } from './localization';
import type { Turn } from '../shared/contracts';
import { ActionMenu } from './ActionMenu';
import { Icon } from './Icon';
import { ReasoningDialog, type ReasoningProps } from './Reasoning';
import { ResponseVariants } from './ResponseVariants';
import { TurnActionButton } from './TurnActionButton';

export function TurnControls({ turn, revision, locked, editing, inputVisible, action, reasoning, select, edit, remove, fork, pin }: {
  turn: Turn;
  revision: number;
  locked: boolean;
  editing: boolean;
  inputVisible: boolean;
  action: { kind: 'regenerate' | 'cancel'; disabled: boolean; run: () => void } | null;
  reasoning: ReasoningProps | null;
  select: (id: string) => Promise<boolean>;
  edit: (part: 'user' | 'assistant') => void;
  remove: () => void;
  pin?: { disabled: boolean; toggle: () => void };
  fork?: { disabled: boolean; open: () => void };
}) {
  useLocale();
  const [inspectedGeneration, setInspectedGeneration] = useState<string | null>(null);
  // A later switch back to the old response must not reopen its inspector.
  if (inspectedGeneration !== null && inspectedGeneration !== reasoning?.generationId) {
    setInspectedGeneration(null);
  }
  return <div className="turn-controls" role="group" aria-label={t("turn_controls.turn_controls")}>
    <ResponseVariants turn={turn} locked={locked || editing} select={select}
      regenerating={turn.complete && action?.kind === 'cancel'}
      regenerate={action?.kind === 'regenerate' && !action.disabled ? action.run : undefined} />
    <div className="turn-actions">
      {action && <TurnActionButton action={action.kind} label={action.kind === 'cancel' ? t("character_import.cancel") : t("turn_controls.regenerate")} disabled={action.disabled} onClick={action.run} />}
      {inputVisible && <TurnActionButton action="input" label={t("turn_controls.edit_input")} disabled={locked} onClick={() => edit('user')} />}
      <TurnActionButton action="response" label={t("turn_controls.edit_response")} disabled={locked || !turn.complete} onClick={() => edit('assistant')} />
      {pin && <TurnActionButton action={turn.pinned ? 'unpin' : 'pin'} label={t(turn.pinned ? 'pins.unpin' : 'pins.pin')}
        disabled={locked || editing || pin.disabled} onClick={pin.toggle} />}
      <ActionMenu label={t('turn_controls.more_actions')} disabled={locked && !reasoning} revision={revision} focusMode="panel">
        {reasoning && <button type="button" className="secondary" role="menuitem" tabIndex={-1} aria-haspopup="dialog"
          onClick={() => setInspectedGeneration(reasoning.generationId)}><Icon name="LightBulb" />{t('reasoning.show_reasoning')}</button>}
        {fork && <button type="button" className="secondary" role="menuitem" tabIndex={-1} aria-haspopup="dialog"
          disabled={locked || editing || fork.disabled} onClick={fork.open}><Icon name="GitBranch" />{t('branches.fork')}</button>}
        <button type="button" className="secondary turn-action-delete" role="menuitem" tabIndex={-1} aria-haspopup="dialog"
          disabled={locked} onClick={remove}><Icon name="TrashOutline" />{t('app.delete_turn_2')}</button>
      </ActionMenu>
    </div>
    {reasoning && inspectedGeneration === reasoning.generationId &&
      <ReasoningDialog {...reasoning} close={() => setInspectedGeneration(null)} />}
  </div>;
}
