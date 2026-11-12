import { useEffect, useState, type RefObject } from 'react';
import type { StoryPreparation } from '../shared/transcript';
import { locale, t, useLocale } from './localization';

export function PreparationStatus({ preparation, transcript, hasOlderTurns, disabled, stop, review }: {
  preparation: StoryPreparation;
  transcript: RefObject<HTMLDivElement | null>;
  hasOlderTurns: boolean;
  disabled: boolean;
  stop: () => void;
  review: () => void;
}) {
  useLocale();
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

  const { working, phase, retrying, deletionReviewToken } = preparation;
  const activity = retrying ? t('story_preparation.retry_wait')
    : phase ? t(`repair_review.phase_${phase}`) : '';
  const formatted = (tokens: number) => tokens.toLocaleString(locale());
  return <div className="recovery memory-preparation-status" data-older-control-visible={hasOlderTurns && olderControlVisible ? '' : undefined}>
    <div role="status">
      <strong>{t('app.preparing_memory')}</strong>
      <p>{working
        ? t('story_preparation.working_input', { input: formatted(working.inputTokens), target: formatted(working.targetInputTokens) })
        : t('app.counting_current_input')}</p>
      {deletionReviewToken && <p>{t('memory.preparation_deletion_waiting')}</p>}
      {activity && <small>{activity}</small>}
    </div>
    <div className="actions">
      {deletionReviewToken && <button type="button" className="secondary" disabled={disabled} onClick={review}>{t('memory.review_preparation_deletion')}</button>}
      <button type="button" className="secondary" disabled={disabled} onClick={stop}>{t('story_preparation.stop')}</button>
    </div>
  </div>;
}
