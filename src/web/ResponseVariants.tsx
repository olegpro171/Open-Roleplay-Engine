import { useEffect, useRef, useState } from 'react';
import type { Turn } from '../shared/contracts';

export function ResponseVariants({ turn, action, locked, select }: {
  turn: Turn; locked: boolean;
  action: { kind: 'regenerate' | 'cancel'; disabled: boolean; run: () => void } | null;
  select: (id: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const selecting = useRef(false);
  const variants = turn.variants ?? [];
  const activeIndex = variants.findIndex(variant => variant.id === turn.assistant.variantId);
  // Reserve the first response's slot without creating a saved variant before success.
  const versionCount = turn.complete ? variants.length : 1;
  const activeNumber = turn.complete ? activeIndex + 1 : 1;
  const selectionLocked = locked || !turn.complete;
  const validDraft = draft === null || (/^\d+$/.test(draft) && Number(draft) >= 1 && Number(draft) <= versionCount);
  useEffect(() => setDraft(null), [turn.assistant.variantId, turn.assistant.revision]);

  async function choose(index: number) {
    if (selectionLocked || selecting.current) return;
    setDraft(null);
    const variant = variants[index];
    if (!variant || index === activeIndex) return;
    // Enter, blur and arrow clicks may arrive before the parent disables the
    // control. Keep them one command and show only the server-confirmed choice.
    selecting.current = true;
    try { await select(variant.id); }
    finally { selecting.current = false; }
  }
  function commitDraft() {
    if (draft === null) return;
    if (validDraft) void choose(Number(draft) - 1);
    else setDraft(null);
  }

  if (variants.length < 2 && !action) return null;
  return <div className="response-variants">
    <div className="variant-selector" role="group" aria-label="Response versions">
      <button type="button" className="quiet variant-arrow" aria-label="Previous response" title="Previous response"
        disabled={selectionLocked || activeIndex <= 0} onPointerDown={event => event.preventDefault()} onClick={() => void choose(activeIndex - 1)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7" /></svg>
      </button>
      <input className="variant-number" type="text" inputMode="numeric" aria-label="Response version"
        title={`Response version, 1 to ${versionCount}. Press Enter to jump.`}
        autoComplete="off" spellCheck={false} disabled={selectionLocked} aria-invalid={!validDraft || undefined}
        value={draft ?? String(activeNumber)} onChange={event => setDraft(event.target.value)}
        onFocus={event => event.currentTarget.select()}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); commitDraft(); }
          else if (event.key === 'Escape') { event.preventDefault(); setDraft(null); }
        }}
        onBlur={commitDraft} />
      <span className="variant-total" aria-label={`${versionCount} response versions`}>/ {versionCount}</span>
      <button type="button" className="quiet variant-arrow" aria-label="Next response" title="Next response"
        disabled={selectionLocked || activeIndex < 0 || activeIndex >= variants.length - 1} onPointerDown={event => event.preventDefault()} onClick={() => void choose(activeIndex + 1)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
      </button>
    </div>
    {action && <button type="button" className="quiet" disabled={action.disabled} onClick={action.run}>{action.kind === 'cancel' ? 'Cancel' : 'Regenerate response'}</button>}
  </div>;
}
