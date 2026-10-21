import { t, useLocale } from './localization';
import { Icon } from './Icon';
import { useEffect, useRef, useState } from 'react';
import type { Turn } from '../shared/contracts';

export function ResponseVariants({ turn, locked, select }: {
  turn: Turn; locked: boolean;
  select: (id: string) => Promise<boolean>;
}) {
  useLocale();
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

  return <div className="variant-selector" role="group" aria-label={t("response_variants.response_versions")}>
    <button type="button" className="quiet variant-arrow" aria-label={t("response_variants.previous_response")} title={t("response_variants.previous_response")}
      disabled={selectionLocked || activeIndex <= 0} onPointerDown={event => event.preventDefault()} onClick={() => void choose(activeIndex - 1)}>
      <Icon name="ArrowShortBack" />
    </button>
    <input className="variant-number" type="text" inputMode="numeric" aria-label={t("response_variants.response_version")}
      title={t("response_variants.response_version_1_to_press_enter_to", { versionCount: versionCount })}
      autoComplete="off" spellCheck={false} disabled={selectionLocked} aria-invalid={!validDraft || undefined}
      value={draft ?? String(activeNumber)} onChange={event => setDraft(event.target.value)}
      onFocus={event => event.currentTarget.select()}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); commitDraft(); }
        else if (event.key === 'Escape') { event.preventDefault(); setDraft(null); }
      }}
      onBlur={commitDraft} />
    <span className="variant-total" aria-label={t("response_variants.response_versions_2", { versionCount: versionCount })}>/ {versionCount}</span>
    <button type="button" className="quiet variant-arrow" aria-label={t("response_variants.next_response")} title={t("response_variants.next_response")}
      disabled={selectionLocked || activeIndex < 0 || activeIndex >= variants.length - 1} onPointerDown={event => event.preventDefault()} onClick={() => void choose(activeIndex + 1)}>
      <Icon name="ArrowShortForward" />
    </button>
  </div>;
}
