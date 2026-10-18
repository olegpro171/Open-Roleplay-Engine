import { useEffect, useRef, useState } from 'react';
import type { Turn } from '../shared/contracts';
import { Dropdown } from './Controls';

export function ResponseVariants({ turn, canRegenerate, locked, hasLore, regenerate, select, inspect }: {
  turn: Turn; canRegenerate: boolean; locked: boolean; hasLore: boolean;
  regenerate: () => void; select: (id: string) => void; inspect: (generationId: string) => void;
}) {
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = useRef<HTMLDivElement>(null);
  useEffect(() => setPreviewId(null), [turn.assistant.variantId]);
  useEffect(() => { preview.current?.scrollIntoView({ block: 'nearest' }); }, [previewId]);
  const variants = turn.variants ?? [];
  const shown = variants.find(variant => variant.id === (previewId ?? turn.assistant.variantId));
  const alternative = shown && shown.id !== turn.assistant.variantId;
  const generationId = shown?.generationId;
  return <div className="response-variants">
    <div className="variant-controls">
      {variants.length > 1 && <label>Response<Dropdown aria-label="Response variant" value={shown?.id ?? ''}
        options={variants.map((variant, index) => ({ value: variant.id, label: `${index + 1} of ${variants.length}${variant.id === turn.assistant.variantId ? ' · selected' : ''}` }))}
        onChange={setPreviewId} /></label>}
      {alternative && <button className="secondary" disabled={locked} onClick={() => select(shown.id)}>Use this response</button>}
      {generationId && variants.length > 1 && <button className="quiet" onClick={() => inspect(generationId)}>Inspect response request</button>}
      {canRegenerate && <button className="quiet" disabled={locked} onClick={regenerate}>Regenerate response</button>}
    </div>
    {alternative && <div ref={preview} className="variant-preview" aria-label="Response preview">
      <p className="small muted">Preview only. The selected response above remains in the story until you choose Use this response. Later turns will stay unchanged.{hasLore ? ' Using another response starts fresh lore activation history.' : ''}</p>
      <div className="prose">{shown.text || <span className="muted blank">blank</span>}</div>
    </div>}
  </div>;
}
