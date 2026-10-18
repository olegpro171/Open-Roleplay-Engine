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
  return <div className="turn-controls" role="group" aria-label="Turn controls">
    <ResponseVariants turn={turn} locked={locked || editing} select={select} />
    <div className="turn-actions">
      {action && <TurnActionButton action={action.kind} label={action.kind === 'cancel' ? 'Cancel' : 'Regenerate response'} disabled={action.disabled} onClick={action.run} />}
      {inputVisible && <TurnActionButton action="input" label="Edit input" disabled={locked} onClick={() => edit('user')} />}
      <TurnActionButton action="response" label="Edit response" disabled={locked || !turn.complete} onClick={() => edit('assistant')} />
      {reasoning && <Reasoning key={reasoning.generationId} {...reasoning} />}
      <TurnActionButton action="delete" label="Delete turn" disabled={locked} onClick={remove} />
    </div>
  </div>;
}
