import { t, useLocale, locale } from './localization';
import { Icon } from './Icon';
import { useEffect, useId, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Option = { value: string; label: string; disabled?: boolean; leading?: ReactNode };
type DropdownProps = {
  value: string; onChange: (value: string) => void; options: Option[];
  'aria-label'?: string; disabled?: boolean; editable?: boolean; required?: boolean;
};

export function Dropdown({ value, onChange, options, disabled, editable, required, 'aria-label': label }: DropdownProps) {
  useLocale();
  const id = useId(), anchor = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 280 });
  const visible = editable ? options.filter(option => option.label.toLowerCase().includes(value.toLowerCase())).slice(0, 100) : options;
  const expanded = open && visible.length > 0 && !disabled;
  const activeIndex = Math.min(active, Math.max(0, visible.length - 1));
  const selected = options.find(option => option.value === value);
  // A modal makes outside content inert, so its options must share the dialog.
  const portalTarget = anchor.current?.closest('dialog[open]') ?? document.body;
  function show() {
    const index = visible.findIndex(option => option.value === value);
    setActive(Math.max(0, index)); setOpen(true);
  }
  useLayoutEffect(() => {
    if (!expanded) return;
    const place = () => {
      const rect = anchor.current!.getBoundingClientRect();
      const below = innerHeight - rect.bottom - 12, above = rect.top - 12;
      const upwards = below < Math.min(240, visible.length * 42 + 12) && above > below;
      const maxHeight = Math.min(280, upwards ? above : below);
      setPosition({ left: rect.left, width: rect.width, top: upwards ? rect.top - Math.min(maxHeight, visible.length * 42 + 12) - 5 : rect.bottom + 5, maxHeight });
    };
    place();
    const outside = (event: PointerEvent) => { if (!anchor.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false); };
    const blur = (event: FocusEvent) => { if (!anchor.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', blur);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', blur); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [expanded, visible.length]);
  useEffect(() => { if (expanded) popup.current?.querySelector('[data-active=true]')?.scrollIntoView({ block: 'nearest' }); }, [activeIndex, expanded]);
  function choose(option: Option) { if (!option.disabled && !anchor.current?.querySelector(':disabled')) onChange(option.value); setOpen(false); }
  const props = {
    role: 'combobox' as const, 'aria-label': label, 'aria-expanded': expanded, 'aria-controls': expanded ? id : undefined,
    'aria-haspopup': 'listbox' as const, 'aria-activedescendant': expanded ? `${id}-${activeIndex}` : undefined, disabled,
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (expanded) event.preventDefault();
        setOpen(false);
        event.stopPropagation();
      }
      else if (event.key === 'Tab') setOpen(false);
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!expanded) show();
        else {
          const step = event.key === 'ArrowDown' ? 1 : -1;
          let next = activeIndex;
          for (let i = 0; i < visible.length; i++) { next = (next + step + visible.length) % visible.length; if (!visible[next].disabled) break; }
          setActive(next);
        }
      } else if (expanded && (event.key === 'Enter' || (!editable && event.key === ' '))) { event.preventDefault(); choose(visible[activeIndex]); }
      else if (expanded && !editable && (event.key === 'Home' || event.key === 'End')) { event.preventDefault(); setActive(event.key === 'Home' ? 0 : visible.length - 1); }
      else if (!editable && event.key.length === 1) {
        const index = visible.findIndex(option => !option.disabled && option.label.toLowerCase().startsWith(event.key.toLowerCase()));
        if (index >= 0) { setOpen(true); setActive(index); }
      }
    },
  };
  return <div className="dropdown" ref={anchor}>
    {editable ? <input {...props} required={required} autoComplete="off" value={value} onFocus={show} onClick={show} onChange={event => { onChange(event.target.value); setActive(0); setOpen(true); }} />
      : <button {...props} type="button" className="select-trigger" onClick={() => expanded ? setOpen(false) : show()}><span className="select-label"><OptionLabel label={selected?.label ?? t("character_editor.none_selected")} leading={selected?.leading} /></span><Icon name="ArrowShortBottom" /></button>}
    {expanded && createPortal(<div ref={popup} id={id} role="listbox" aria-label={label} className="select-menu" style={position} onMouseDown={event => event.preventDefault()}>{visible.map((option, index) => <div role="option" id={`${id}-${index}`} key={option.value} aria-selected={option.value === value} aria-disabled={option.disabled || undefined} data-active={index === activeIndex} onPointerMove={() => setActive(index)} onClick={() => choose(option)}><OptionLabel label={option.label} leading={option.leading} />{option.value === value && <Icon name="Check" />}</div>)}</div>, portalTarget)}
  </div>;
}

function OptionLabel({ label, leading }: Pick<Option, 'label' | 'leading'>) {
  if (!leading) return label;
  return <span className="select-option-content"><span className="select-option-leading" aria-hidden="true">{leading}</span><span className="select-option-text">{label}</span></span>;
}

export function NumberInput({ value, onChange, min = 1, max = 10_000_000, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'type'> & { value: number; onChange: (value: number) => void; min?: number; max?: number }) {
  useLocale();
  const numberLocale = locale();
  const [text, setText] = useState(String(value));
  const input = useRef<HTMLInputElement>(null);
  const published = useRef(value);
  useEffect(() => { if (value !== published.current) { setText(String(value)); published.current = value; } }, [value]);
  useEffect(() => { input.current?.setCustomValidity(text !== '' && (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) ? t("controls.enter_a_whole_number_from_to", { value: min.toLocaleString(numberLocale), value2: max.toLocaleString(numberLocale) }) : ''); }, [text, min, max, numberLocale]);
  return <input {...props} ref={input} type="text" inputMode="numeric" pattern="[0-9]+" value={text} onChange={event => {
    const next = event.target.value; setText(next);
    if (/^\d+$/.test(next)) { published.current = Number(next); onChange(published.current); }
  }} />;
}
