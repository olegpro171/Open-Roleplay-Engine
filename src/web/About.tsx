import { useTextState, errorText, t, message as msg, useLocale } from './localization';
import { useEffect, useState } from 'react';
import { buildInfoSchema, type BuildInfo } from '../shared/build-info';
import { api } from './api';

export function About() {
  useLocale();
  const [info, setInfo] = useState<BuildInfo | null>(null);
  const [error, setError] = useTextState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api<unknown>('/about', 'GET', undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setInfo(buildInfoSchema.parse(value)); })
      .catch(error => { if (!controller.signal.aborted) setError(errorText(error, msg("about.build_information_could_not_be_loaded"))); });
    return () => controller.abort();
  }, [attempt]);
  return <section className="settings-section" aria-labelledby="about-heading">
    <h2 id="about-heading" tabIndex={-1}>{t("about.about_ore")}</h2>
    {error ? <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>{t("about.retry_build_information")}</button></p>
      : !info ? <p role="status">{t("about.loading_build_information")}</p> : <dl className="about-version">
        <dt>{t("about.commit")}</dt><dd><code>{info.commit ?? t("about.unavailable_source_without_git_metadata")}</code></dd>
        <dt>{t("about.database_schema")}</dt><dd>{info.schema}</dd>
        <dt>{t("about.node_runtime")}</dt><dd>{info.node}</dd>
        <dt>{t("about.platform")}</dt><dd>{info.platform} / {info.arch}</dd>
      </dl>}
  </section>;
}
