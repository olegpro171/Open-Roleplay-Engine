import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import type { StoryPreparation } from '../shared/transcript';
import { t, useLocale } from './localization';

export function TranscriptNotices({ transcript, hasOlderTurns, children }: {
  transcript: RefObject<HTMLDivElement | null>;
  hasOlderTurns: boolean;
  children: ReactNode;
}) {
  const [olderControlVisible, setOlderControlVisible] = useState(false);
  useEffect(() => {
    if (!hasOlderTurns) return;
    const scroller = transcript.current;
    const control = scroller?.querySelector('[data-history-direction="older"]');
    if (!scroller || !control) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) setOlderControlVisible(entry.isIntersecting);
    }, { root: scroller });
    observer.observe(control);
    return () => observer.disconnect();
  }, [hasOlderTurns, transcript]);
  return <div className="transcript-notices" data-older-control-visible={hasOlderTurns && olderControlVisible ? '' : undefined}>{children}</div>;
}

export function PreparationStatus({ preparation, disabled, stop, openMemory }: {
  preparation: StoryPreparation;
  disabled: boolean;
  stop: () => void;
  openMemory: () => void;
}) {
  useLocale();
  const { phase, retrying, deletionReviewToken } = preparation;
  const activity = retrying ? t('story_preparation.retry_wait')
    : phase ? t(`repair_review.phase_${phase}`) : '';
  return <div className="recovery memory-preparation-status">
    <div role="status">
      <strong>{t('app.preparing_memory')}</strong>
      {deletionReviewToken && <p>{t('memory.preparation_deletion_waiting')}</p>}
      {activity && <small>{activity}</small>}
    </div>
    <div className="actions">
      {deletionReviewToken && <button type="button" className="secondary" disabled={disabled} onClick={openMemory}>{t('app.inspect_memory')}</button>}
      <button type="button" className="secondary" disabled={disabled} onClick={stop}>{t('story_preparation.stop')}</button>
    </div>
  </div>;
}
