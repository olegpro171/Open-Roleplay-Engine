import { useLayoutEffect, useRef } from 'react';
import type { MemoryCleanupImpact } from '../shared/memory-cleanup';
import { api, datasetChanged } from './api';
import { useConfirmation, type ConfirmationCopy } from './Confirmation';
import { message, t, useLocale } from './localization';

export const saveMemoryCleanupCopy = (): ConfirmationCopy => ({
  title: message('memory_cleanup.review'),
  message: message('memory_cleanup.preset_change'),
  actionLabel: message('memory_cleanup.save_changes'),
});

export function useMemoryCleanup(run: (action: () => Promise<unknown>) => Promise<boolean>, scope?: string | null) {
  const confirm = useConfirmation(scope);
  const visit = useRef(0);
  const reading = useRef(false);
  useLayoutEffect(() => () => { visit.current++; }, [scope]);
  return async function review({ path, body, copy, alwaysConfirm, commit, saved }: {
    path: string;
    body: unknown;
    copy: ConfirmationCopy;
    alwaysConfirm?: boolean;
    commit: (memoryImpactToken?: string) => Promise<unknown>;
    saved?: () => void;
  }) {
    if (reading.current) return;
    reading.current = true;
    const currentVisit = visit.current;
    const focused = document.activeElement;
    let preview: { impact: MemoryCleanupImpact | null } | undefined;
    try {
      if (!await run(async () => { preview = await api(path, 'POST', body); })) return;
    } finally {
      reading.current = false;
    }
    if (!preview || visit.current !== currentVisit || datasetChanged()) return;
    const { impact } = preview;
    const save = async () => {
      if (visit.current !== currentVisit || datasetChanged()) return;
      if (await run(() => commit(impact?.token)) && visit.current === currentVisit) saved?.();
    };
    if (impact || alwaysConfirm) {
      confirm({
        ...copy,
        details: impact ? <CleanupDetails impact={impact} /> : null,
        returnFocus: focused instanceof HTMLElement ? focused : undefined,
        onConfirm: () => void save(),
      });
    } else await save();
  };
}

function CleanupDetails({ impact }: { impact: MemoryCleanupImpact }) {
  useLocale();
  return <ul className="memory-cleanup-branches">{impact.branches.map(branch => <li key={branch.id}>
    <strong>{branch.branchName ? t('memory_cleanup.branch', { title: branch.title, branch: branch.branchName }) : branch.title}</strong>
    {branch.discardedSummaries > 0 && <p>{t('memory_cleanup.discarded', { count: branch.discardedSummaries })}</p>}
    {branch.restoredTurns > 0 && <p>{t('memory_cleanup.restored', { count: branch.restoredTurns })}</p>}
    {branch.corrections.length > 0 && <><strong>{t('memory_cleanup.corrections')}</strong>
      <ul>{branch.corrections.map(correction => <li key={correction.id}>
        {correction.firstTurn === null || correction.lastTurn === null
          ? t('memory_cleanup.correction_level', { level: correction.level })
          : t('memory_cleanup.correction_range', { level: correction.level, first: correction.firstTurn, last: correction.lastTurn })}
        <p>{correction.text}</p>
      </li>)}</ul></>}
  </li>)}</ul>;
}
