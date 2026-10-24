import { currentPack, errorText, loadLanguages, locale, message, publishLanguages, selectLanguage, t, useLanguages, useLocale, useTextState } from './localization';
import { useEffect, useRef, useState } from 'react';
import { extendTranslation, languageLimits, languagePackSchema, languageStatusSchema, translationTemplate, validateTranslations, type LanguagePack } from '../shared/localization';
import { api } from './api';
import { Dropdown } from './Controls';
import { useConfirmation } from './Confirmation';

export function LanguageSettings() {
  useLocale();
  const status = useLanguages();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useTextState('');
  const [notice, setNotice] = useTextState('');
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  const confirm = useConfirmation();
  const selected = status?.languages.find(item => item.locale === locale());
  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (error) { if (mounted.current) setError(errorText(error, message('language.unavailable'))); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    let refreshing = false;
    async function refresh() {
      if (pending.current || refreshing) return;
      refreshing = true;
      try {
        await loadLanguages(true);
      } catch (cause) {
        if (active) setError(errorText(cause, message('language.reloadFailed')));
      } finally { refreshing = false; }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [setError]);
  function download(pack: LanguagePack, filename: string) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  async function inspect(file: File) {
    await run(async () => {
      if (file.size > languageLimits.bytes) throw new Error(t('language.limit'));
      let pack;
      try { pack = languagePackSchema.parse(JSON.parse(await file.text())); validateTranslations(pack); }
      catch { setError(message('language.invalid')); return; }
      const current = await loadLanguages();
      if (!mounted.current) return;
      const installed = current.languages.find(item => item.locale === pack.locale);
      const captured = pack;
      const save = () => void run(async () => {
        const result = await api<unknown>('/localization/import', 'POST', { pack: captured, expectedRevision: installed?.custom ? installed.revision : null });
        publishLanguages(languageStatusSchema.parse(result));
        if (locale() === captured.locale) await selectLanguage(captured.locale, false);
        if (mounted.current) setNotice(message('language.imported'));
      });
      if (installed?.custom) confirm({ title: t('language.confirmTitle'), message: t('language.confirmBody', { language: pack.nativeName }), actionLabel: t('language.replace'), onConfirm: save });
      else {
        const result = await api<unknown>('/localization/import', 'POST', { pack, expectedRevision: null });
        publishLanguages(languageStatusSchema.parse(result));
        if (locale() === pack.locale) await selectLanguage(pack.locale, false);
        if (mounted.current) setNotice(message('language.imported'));
      }
    });
  }
  return <section className="settings-section" aria-labelledby="language-heading">
    <h2 id="language-heading" tabIndex={-1}>{t('language.heading')}</h2>
    <p>{t('language.description')}</p>
    <label>{t('language.select')}<Dropdown aria-label={t('language.select')} disabled={busy} value={locale()} options={(status?.languages ?? [{ locale: 'en', nativeName: 'English' }, { locale: 'ru', nativeName: 'Русский' }]).map(item => ({ value: item.locale, label: item.nativeName }))} onChange={value => void run(async () => {
      if (!await selectLanguage(value)) setError(message('language.storageFailed'));
    })} /></label>
    {selected && <p className="small muted">{t('language.coverage', { translated: selected.translated, total: selected.total })}</p>}
    <div className="actions">
      <button type="button" className="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>{t('language.import')}</button>
      <button type="button" className="secondary" onClick={() => download(translationTemplate(), 'ORE-language-template.json')}>{t('language.template')}</button>
      <button type="button" className="secondary" disabled={busy || locale() === 'en'} aria-describedby="language-extend-help" onClick={() => download(extendTranslation(currentPack()), `${locale()}.json`)}>{t('language.extend')}</button>
    </div>
    <p id="language-extend-help" className="small muted">{t('language.extendHelp')}</p>
    <input ref={fileInput} hidden type="file" accept=".json,application/json" aria-label={t('language.import')} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void inspect(file); }} />
    {busy && <p role="status">{t('language.loading')}</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {status?.issues.map(issue => <p role="status" key={issue.file}>{issue.file}: {t('language.issue')}</p>)}
  </section>;
}
