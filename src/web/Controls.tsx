import { Icon } from './Icon';
import { useEffect, useId, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

type Option = { value: string; label: string; disabled?: boolean };
type DropdownProps = {
  value: string; onChange: (value: string) => void; options: Option[];
  'aria-label'?: string; disabled?: boolean; editable?: boolean; required?: boolean;
};

export function Dropdown({ value, onChange, options, disabled, editable, required, 'aria-label': label }: DropdownProps) {
  const id = useId(), anchor = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, maxHeight: 280 });
  const visible = editable ? options.filter(option => option.label.toLowerCase().includes(value.toLowerCase())).slice(0, 100) : options;
  const expanded = open && visible.length > 0 && !disabled;
  const activeIndex = Math.min(active, Math.max(0, visible.length - 1));
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
      if (event.key === 'Escape') { setOpen(false); event.stopPropagation(); }
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
      : <button {...props} type="button" className="select-trigger" onClick={() => expanded ? setOpen(false) : show()}>{options.find(option => option.value === value)?.label ?? 'None selected'}<Icon name="ArrowShortBottom" /></button>}
    {expanded && createPortal(<div ref={popup} id={id} role="listbox" aria-label={label} className="select-menu" style={position} onMouseDown={event => event.preventDefault()}>{visible.map((option, index) => <div role="option" id={`${id}-${index}`} key={option.value} aria-selected={option.value === value} aria-disabled={option.disabled || undefined} data-active={index === activeIndex} onPointerMove={() => setActive(index)} onClick={() => choose(option)}>{option.label}{option.value === value && <Icon name="Check" />}</div>)}</div>, document.body)}
  </div>;
}

export function NumberInput({ value, onChange, min = 1, max = 10_000_000, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'min' | 'max' | 'type'> & { value: number; onChange: (value: number) => void; min?: number; max?: number }) {
  const [text, setText] = useState(String(value));
  const input = useRef<HTMLInputElement>(null);
  const published = useRef(value);
  useEffect(() => { if (value !== published.current) { setText(String(value)); published.current = value; } }, [value]);
  useEffect(() => { input.current?.setCustomValidity(text !== '' && (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) ? `Enter a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}.` : ''); }, [text, min, max]);
  return <input {...props} ref={input} type="text" inputMode="numeric" pattern="[0-9]+" value={text} onChange={event => {
    const next = event.target.value; setText(next);
    if (/^\d+$/.test(next)) { published.current = Number(next); onChange(published.current); }
  }} />;
}
