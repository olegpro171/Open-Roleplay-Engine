import type { StoryPreparation } from '../shared/transcript';
import { locale, t, useLocale } from './localization';

export function PreparationStatus({ preparation, regeneration, committedInput, disabled, stop, review }: {
  preparation: StoryPreparation;
  regeneration: boolean;
  committedInput?: number;
  disabled: boolean;
  stop: () => void;
  review: () => void;
}) {
  useLocale();
  const { working, completedSteps, mode, phase, retrying } = preparation;
  const level = working?.level;
  const step = completedSteps + 1;
  const operation = mode === 'repair' ? t('story_preparation.repairing')
    : level === 1 ? t('story_preparation.batch', { step })
      : level ? t('story_preparation.promotion', { step, level }) : t('story_preparation.checking');
  const activity = retrying ? t('story_preparation.retry_wait')
    : phase ? t(`repair_review.phase_${phase}`) : '';
  const formatted = (tokens: number) => tokens.toLocaleString(locale());
  return <div className="recovery memory-preparation-status">
    <div role="status">
      <strong>{t(regeneration ? 'story_preparation.regeneration' : 'app.preparing_memory')}</strong>
      <p>{working
        ? t('story_preparation.working_input', { input: formatted(working.inputTokens), target: formatted(working.targetInputTokens) })
        : t('app.counting_current_input')}</p>
      {(mode === 'prepare' || regeneration) && <p>{committedInput === undefined
        ? t('story_preparation.counting_committed_input')
        : t('story_preparation.committed_input', { input: formatted(committedInput) })}</p>}
      <p>{preparation.deletionReviewToken ? t('memory.preparation_deletion_waiting') : operation}</p>
      {activity && <small>{activity}</small>}
    </div>
    <div className="actions">
      {preparation.deletionReviewToken && <button type="button" className="secondary" disabled={disabled} onClick={review}>{t('memory.review_preparation_deletion')}</button>}
      <button type="button" className="secondary" disabled={disabled} onClick={stop}>{t('story_preparation.stop')}</button>
    </div>
  </div>;
}
