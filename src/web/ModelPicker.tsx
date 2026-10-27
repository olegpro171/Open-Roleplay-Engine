import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { z } from 'zod';
import { connectionSchema } from '../shared/contracts';
import { api } from './api';
import { openModal } from './dialog-focus';
import { Icon } from './Icon';
import { errorText, formatMessage, LocalizedError, message, t, useLocale, type MessageText } from './localization';

type ModelSource = { endpoint: string; connectionId?: string; apiKey?: string };
type Discovery = { kind: 'loading' } | { kind: 'ready'; models: string[] } | { kind: 'failed'; error: MessageText };
const modelsSchema = z.object({ models: z.array(connectionSchema.shape.model).max(10_000) });
const pageSize = 100;

export function ModelField({ value, change, disabled, ...source }: ModelSource & {
  value: string; change: (model: string) => void; disabled: boolean;
}) {
  useLocale();
  const id = useId();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <div className="full model-field">
    <label htmlFor={id}>{t('libraries.model_identifier')}</label>
    <button id={id} type="button" className="select-trigger" disabled={disabled} aria-haspopup="dialog"
      onClick={() => setOpen(true)}>
      <span className={value ? 'select-label' : 'model-placeholder'}>{value || t('model_picker.select')}</span>
      <Icon name="ArrowShortBottom" />
    </button>
    {open && !disabled && <ModelPicker {...source} value={value} cancel={() => setOpen(false)} select={model => {
      change(model);
      setOpen(false);
    }} />}
  </div>;
}

function ModelPicker({ value, endpoint, connectionId, apiKey, cancel, select }: ModelSource & {
  value: string; cancel: () => void; select: (model: string) => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(pageSize);
  const [attempt, setAttempt] = useState(0);
  const [discovery, setDiscovery] = useState<Discovery>({ kind: 'loading' });
  const manual = connectionSchema.shape.model.safeParse(query);
  const filter = query.toLowerCase();
  const matches = discovery.kind === 'ready'
    ? discovery.models.filter(model => model.toLowerCase().includes(filter)) : [];

  useLayoutEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const trigger = document.activeElement;
    const viewport = window.visualViewport;
    const resize = () => {
      // The entire picker occupies the visible area above the keyboard. Its
      // input and footer stay in flow; only the model list gives up space.
      const viewportWidth = viewport?.width ?? innerWidth;
      const availableHeight = (viewport?.height ?? innerHeight) - 16;
      const width = Math.max(0, Math.min(560, viewportWidth - 16));
      node.style.width = `${width}px`;
      node.style.height = `${Math.max(0, viewportWidth <= 800 ? availableHeight : Math.min(640, availableHeight))}px`;
      node.style.left = `${(viewport?.offsetLeft ?? 0) + (viewportWidth - width) / 2}px`;
      node.style.top = `${(viewport?.offsetTop ?? 0) + 8}px`;
    };
    resize();
    // There is no visible title row. Focus the dialog itself from the start,
    // before showModal can focus the search field and raise a phone keyboard.
    node.autofocus = true;
    openModal(node);
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    window.addEventListener('resize', resize);
    return () => {
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
      window.removeEventListener('resize', resize);
      node.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setDiscovery({ kind: 'loading' });
    void (async () => {
      try {
        const result = modelsSchema.safeParse(await api<unknown>('/models', 'POST', {
          endpoint, ...(connectionId ? { connectionId } : {}), ...(apiKey !== undefined ? { apiKey } : {}),
        }, controller.signal));
        if (!result.success) throw new LocalizedError(message('libraries.could_not_fetch_models_check_the_api'));
        if (!controller.signal.aborted) setDiscovery({ kind: 'ready', models: result.data.models });
      } catch (error) {
        if (!controller.signal.aborted) setDiscovery({ kind: 'failed', error: errorText(error, message('libraries.could_not_fetch_models_check_the_api')) });
      }
    })();
    return () => controller.abort();
  }, [endpoint, connectionId, apiKey, attempt]);

  function navigate(event: KeyboardEvent<HTMLButtonElement>) {
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[data-model]') ?? []);
    const index = buttons.indexOf(event.currentTarget);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : event.key === 'ArrowDown' ? Math.min(index + 1, buttons.length - 1)
      : event.key === 'ArrowUp' ? Math.max(0, index - 1) : null;
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus({ preventScroll: true });
    buttons[next]?.scrollIntoView({ block: 'nearest' });
  }

  return createPortal(<dialog ref={dialog} className="model-picker" aria-label={t('model_picker.select')} tabIndex={-1}
    onCancel={event => { event.preventDefault(); cancel(); }}>
    <form onSubmit={event => {
      // The portal still belongs to the Connection editor in React's event
      // tree. Submitting a model must never submit/save that outer editor.
      event.preventDefault();
      event.stopPropagation();
      if (manual.success) select(manual.data);
    }}>
      <div className="model-picker-search">
        <input aria-label={t('model_picker.search')} placeholder={t('model_picker.search')} autoComplete="off" autoCapitalize="none"
          spellCheck={false} maxLength={200} value={query} onChange={event => {
            setQuery(event.target.value); setLimit(pageSize);
            if (list.current) list.current.scrollTop = 0;
          }} onKeyDown={event => {
            if (event.key !== 'ArrowDown') return;
            const first = list.current?.querySelector<HTMLButtonElement>('[data-model]');
            if (first) { event.preventDefault(); first.focus({ preventScroll: true }); first.scrollIntoView({ block: 'nearest' }); }
          }} />
      </div>
      <div ref={list} className="model-picker-list" role="region" aria-label={t('model_picker.models')} aria-busy={discovery.kind === 'loading'}>
        {discovery.kind === 'loading' && <p role="status">{t('model_picker.loading')}</p>}
        {discovery.kind === 'failed' && <div className="model-picker-notice">
          <p role="alert">{formatMessage(discovery.error)}</p>
          <button type="button" className="secondary" onClick={() => setAttempt(current => current + 1)}>{t('model_picker.retry')}</button>
        </div>}
        {discovery.kind === 'ready' && (matches.length ? <>
          {matches.slice(0, limit).map(model => <button key={model} type="button" className="quiet model-picker-option" data-model
            aria-pressed={model === value} onKeyDown={navigate} onClick={() => select(model)}>
            <span>{model}</span>{model === value && <Icon name="Check" />}
          </button>)}
          {matches.length > limit && <button type="button" className="secondary" onClick={() => setLimit(current => current + pageSize)}>{t('model_picker.more')}</button>}
        </> : <p role="status">{t(discovery.models.length ? 'model_picker.no_matches' : 'libraries.the_provider_returned_an_empty_model_list')}</p>)}
      </div>
      <div className="model-picker-footer">
        <button type="button" className="secondary" onClick={cancel}>{t('character_import.cancel')}</button>
        <button type="submit" disabled={!manual.success}>{t('model_picker.submit')}</button>
      </div>
    </form>
  </dialog>, document.body);
}
