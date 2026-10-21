import { errorText, loadLanguages, locale, message, publishLanguages, selectLanguage, t, useLanguages, useLocale, useTextState, type MessageText } from './localization';
import { useEffect, useRef, useState } from 'react';
import { languageLimits, languagePackSchema, languageStatusSchema, translationTemplate, validateTranslations } from '../shared/localization';
import { api } from './api';
import { Dropdown } from './Controls';
import { useConfirmation } from './Confirmation';

export function LanguageSwitcher({ onError }: { onError: (error: MessageText) => void }) {
  useLocale();
  const status = useLanguages();
  const [busy, setBusy] = useState(false);
  return <select className="language-switcher" aria-label={t('language.switch')} title={t('language.select')} value={locale()} disabled={busy} onChange={event => {
    const language = event.target.value;
    setBusy(true);
    void selectLanguage(language).then(saved => { if (!saved) onError(message('language.storageFailed')); })
      .catch(error => onError(errorText(error, message('language.unavailable')))).finally(() => setBusy(false));
  }}>{(status?.languages ?? [{ locale: 'en', nativeName: 'English' }, { locale: 'ru', nativeName: 'Русский' }]).map(item => <option key={item.locale} value={item.locale}>{item.nativeName}</option>)}</select>;
}

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
  async function refresh() {
    await run(async () => {
      const result = await loadLanguages(true);
      if (result.issues.some(issue => issue.file === 'languages')) setError(message('language.reloadFailed'));
      else setNotice(message('language.reloaded'));
    });
  }
  function template() {
    const pack = translationTemplate();
    const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'ORE-language-template.json'; link.click();
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
    <div className="actions"><button type="button" className="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>{t('language.import')}</button><button type="button" className="secondary" onClick={template}>{t('language.template')}</button><button type="button" className="secondary" disabled={busy} onClick={() => void refresh()}>{t('language.reload')}</button></div>
    <input ref={fileInput} hidden type="file" accept=".json,application/json" aria-label={t('language.import')} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void inspect(file); }} />
    {busy && <p role="status">{t('language.loading')}</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {status?.issues.map(issue => <p role="status" key={issue.file}>{issue.file}: {t('language.issue')}</p>)}
  </section>;
}
