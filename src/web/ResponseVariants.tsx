import { t, useLocale } from './localization';
import { Icon } from './Icon';
import { useEffect, useRef, useState } from 'react';
import type { TranscriptTurn } from '../shared/transcript';

export function ResponseVariants({ turn, locked, regenerating, regenerate, select }: {
  turn: TranscriptTurn; locked: boolean;
  regenerating: boolean;
  regenerate?: () => void;
  select: (id: string) => Promise<boolean>;
}) {
  useLocale();
  const variants = turn.variants ?? [];
  const activeIndex = variants.findIndex(variant => variant.id === turn.assistant.variantId);
  // Reserve a display slot; a response variant is saved only after success.
  const versionCount = turn.complete ? variants.length + Number(regenerating) : 1;
  const activeNumber = regenerating ? versionCount : turn.complete ? activeIndex + 1 : 1;
  return <VariantSelector kind="response" number={activeNumber} total={versionCount} locked={locked || !turn.complete}
    selectionIdentity={turn.assistant.variantId + ':' + turn.assistant.revision}
    nextAction={regenerate && activeIndex === variants.length - 1 ? { label: t('turn_controls.regenerate_response'), run: regenerate } : undefined}
    choose={number => select(variants[number - 1].id)} />;
}

export function VariantSelector({ kind, number, total, locked, selectionIdentity, choose, nextAction }: {
  kind: 'response' | 'suggestion'; number: number; total: number; locked: boolean; selectionIdentity: string;
  choose: (number: number) => Promise<unknown> | void; nextAction?: { label: string; run: () => void };
}) {
  useLocale();
  const [draft, setDraft] = useState<string | null>(null);
  const selecting = useRef(false);
  const suggestion = kind === 'suggestion';
  const atNewest = number === total;
  const previousLabel = t(suggestion ? 'impersonate.previous' : 'response_variants.previous_response');
  const nextLabel = t(suggestion ? 'impersonate.next' : 'response_variants.next_response');
  const nextTitle = nextAction?.label ?? nextLabel;
  const validDraft = draft === null || (/^\d+$/.test(draft) && Number(draft) >= 1 && Number(draft) <= total);
  useEffect(() => setDraft(null), [selectionIdentity, number, total]);

  async function selectNumber(target: number) {
    if (locked || selecting.current) return;
    setDraft(null);
    if (target === number || target < 1 || target > total) return;
    // Enter, blur and arrow clicks can arrive before a selection is acknowledged.
    selecting.current = true;
    try { await choose(target); }
    finally { selecting.current = false; }
  }
  function commitDraft() {
    if (draft === null) return;
    if (validDraft) void selectNumber(Number(draft));
    else setDraft(null);
  }

  return <div className="variant-selector" role="group" aria-label={t(suggestion ? 'impersonate.versions' : 'response_variants.response_versions')}>
    <button type="button" className="quiet variant-arrow" aria-label={previousLabel} title={previousLabel}
      disabled={locked || number <= 1} onPointerDown={event => event.preventDefault()} onClick={() => void selectNumber(number - 1)}>
      <Icon name="ArrowShortBack" />
    </button>
    <input className="variant-number" type="text" inputMode="numeric" aria-label={t(suggestion ? 'impersonate.version' : 'response_variants.response_version')}
      title={t(suggestion ? 'impersonate.jump' : 'response_variants.response_version_1_to_press_enter_to', { versionCount: total })}
      autoComplete="off" spellCheck={false} disabled={locked || !total} aria-invalid={!validDraft || undefined}
      value={draft ?? String(number)} onChange={event => setDraft(event.target.value)}
      onFocus={event => event.currentTarget.select()}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); commitDraft(); }
        else if (event.key === 'Escape') { event.preventDefault(); setDraft(null); }
      }}
      onBlur={commitDraft} />
    <span className="variant-total" aria-label={t(suggestion ? 'impersonate.total' : 'response_variants.response_versions_2', { versionCount: total })}>/ {total}</span>
    <button type="button" className="quiet variant-arrow" aria-label={nextLabel} aria-description={nextAction?.label} title={nextTitle}
      disabled={locked || (!nextAction && (number === 0 || atNewest))} onPointerDown={event => event.preventDefault()} onClick={() => {
        if (locked || selecting.current) return;
        if (nextAction) { setDraft(null); nextAction.run(); }
        else void selectNumber(number + 1);
      }}>
      <Icon name="ArrowShortForward" />
    </button>
  </div>;
}
