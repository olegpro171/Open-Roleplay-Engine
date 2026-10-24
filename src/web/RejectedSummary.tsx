import { t, useLocale } from './localization';

export function RejectedSummary({ text }: { text: string }) {
  useLocale();
  return <details className="repair-rejected">
    <summary>{t("repair_review.inspect_rejected_summary")}</summary>
    <p className="small muted">{t("repair_review.rejected_summary_is_read_only")}</p>
    <div className="prose summary-text" role="region" aria-label={t("repair_review.rejected_summary")} tabIndex={0}>{text}</div>
  </details>;
}
