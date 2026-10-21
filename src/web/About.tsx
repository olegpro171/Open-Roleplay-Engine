import { useEffect, useState } from 'react';
import { buildInfoSchema, type BuildInfo } from '../shared/build-info';
import { api } from './api';

export function About() {
  const [info, setInfo] = useState<BuildInfo | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api<unknown>('/about', 'GET', undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setInfo(buildInfoSchema.parse(value)); })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Build information could not be loaded.'); });
    return () => controller.abort();
  }, [attempt]);
  return <section className="settings-section" aria-labelledby="about-heading">
    <h2 id="about-heading" tabIndex={-1}>About ORE</h2>
    {error ? <p role="alert">{error} <button onClick={() => setAttempt(value => value + 1)}>Retry build information</button></p>
      : !info ? <p role="status">Loading build information…</p> : <dl className="about-version">
        <dt>Commit</dt><dd><code>{info.commit ?? 'Unavailable (source without Git metadata)'}</code></dd>
        <dt>Database schema</dt><dd>{info.schema}</dd>
        <dt>Node runtime</dt><dd>{info.node}</dd>
        <dt>Platform</dt><dd>{info.platform} / {info.arch}</dd>
      </dl>}
  </section>;
}
