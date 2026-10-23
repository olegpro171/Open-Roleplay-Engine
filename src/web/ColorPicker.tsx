import { openModal } from './dialog-focus';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { speechColorSchema } from '../shared/appearance';
import { type MessageKey } from '../shared/localization';
import { t, useLocale } from './localization';
import { hexToHsl, hslToHex, type HslColor } from './hsl-color';

const presetGroups: { label: MessageKey; colors: { name: MessageKey; hex: string }[] }[] = [
  { label: 'color_picker.vivid', colors: [
    { name: 'color_picker.coral', hex: '#f07878' }, { name: 'color_picker.orange', hex: '#efaa65' },
    { name: 'color_picker.gold', hex: '#e8cc65' }, { name: 'color_picker.green', hex: '#75c58e' },
    { name: 'color_picker.teal', hex: '#59c6ba' }, { name: 'color_picker.blue', hex: '#73a9ed' },
    { name: 'color_picker.violet', hex: '#aa8aeb' }, { name: 'color_picker.pink', hex: '#e98cbb' },
  ] },
  { label: 'color_picker.pastels', colors: [
    { name: 'color_picker.rose', hex: '#f2b8c6' }, { name: 'color_picker.peach', hex: '#f4c6a6' },
    { name: 'color_picker.butter', hex: '#f1e2a4' }, { name: 'color_picker.mint', hex: '#b8dfc4' },
    { name: 'color_picker.aqua', hex: '#afe2df' }, { name: 'color_picker.sky', hex: '#a8c9f0' },
    { name: 'color_picker.lavender', hex: '#cec0ee' }, { name: 'color_picker.lilac', hex: '#e4c0e4' },
  ] },
  { label: 'color_picker.muted_neutrals', colors: [
    { name: 'color_picker.dusty_rose', hex: '#bb929d' }, { name: 'color_picker.clay', hex: '#c3a58e' },
    { name: 'color_picker.sage', hex: '#a4b59b' }, { name: 'color_picker.slate', hex: '#95a9be' },
    { name: 'color_picker.cream', hex: '#eee5d5' }, { name: 'color_picker.silver', hex: '#b8bec8' },
    { name: 'color_picker.white', hex: '#ffffff' }, { name: 'color_picker.charcoal', hex: '#3c4350' },
  ] },
];

export function ColorPicker({ label, value, onChange, disabled = false }: {
  label: string; value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return <>
    <button type="button" className="secondary color-picker-trigger" aria-label={label} aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(true)}>
      <span className="color-picker-swatch" style={{ backgroundColor: value }} aria-hidden="true" />
      <span dir="ltr">{value.toUpperCase()}</span>
      <span className="color-picker-edit">{t('color_picker.edit')}</span>
    </button>
    {open && !disabled && <ColorPickerDialog label={label} value={value} cancel={() => setOpen(false)} apply={color => { onChange(color); setOpen(false); }} />}
  </>;
}

function ColorPickerDialog({ label, value, cancel, apply }: {
  label: string; value: string; cancel: () => void; apply: (color: string) => void;
}) {
  useLocale();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId(), descriptionId = useId(), errorId = useId();
  const [hsl, setHsl] = useState(() => hexToHsl(value));
  const [color, setColor] = useState(value);
  const [hexDraft, setHexDraft] = useState(value);
  const valid = speechColorSchema.safeParse(hexDraft).success;

  useLayoutEffect(() => {
    const trigger = document.activeElement;
    const node = dialog.current;
    openModal(node);
    return () => {
      node?.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  function chooseHex(hex: string) {
    setHexDraft(hex);
    const parsed = speechColorSchema.safeParse(hex);
    if (parsed.success) {
      setColor(parsed.data);
      setHsl(hexToHsl(parsed.data));
    }
  }

  function changeHsl(channel: keyof HslColor, next: number) {
    // Keep HSL as the editing source, preserving hue through gray, black and white.
    const updated = { ...hsl, [channel]: next };
    const hex = hslToHex(updated);
    setHsl(updated);
    setColor(hex);
    setHexDraft(hex);
  }

  const channels: { channel: keyof HslColor; label: MessageKey; max: number; unit: string; background: string }[] = [
    { channel: 'hue', label: 'color_picker.hue', max: 360, unit: '°', background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' },
    { channel: 'saturation', label: 'color_picker.saturation', max: 100, unit: '%', background: `linear-gradient(to right, hsl(${hsl.hue} 0% ${hsl.lightness}%), hsl(${hsl.hue} 100% ${hsl.lightness}%))` },
    { channel: 'lightness', label: 'color_picker.lightness', max: 100, unit: '%', background: `linear-gradient(to right, #000, hsl(${hsl.hue} ${hsl.saturation}% 50%), #fff)` },
  ];

  return createPortal(<dialog ref={dialog} className="color-picker-dialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); cancel(); }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)'));
      const first = controls[0], last = controls.at(-1);
      const onControl = controls.some(control => control === document.activeElement);
      if (event.shiftKey && (!onControl || document.activeElement === first)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (!onControl || document.activeElement === last)) {
        event.preventDefault();
        first?.focus();
      }
    }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) cancel();
    }}>
    <header className="color-picker-heading"><h2 id={titleId}>{t('color_picker.title')}</h2><p id={descriptionId}>{label}</p></header>
    <div className="color-picker-body">
      <div className="color-picker-preview">
        <div><span className="color-picker-swatch" style={{ backgroundColor: value }} aria-hidden="true" /><small>{t('color_picker.current')}</small></div>
        <div><span className="color-picker-swatch" style={{ backgroundColor: color }} aria-hidden="true" /><small>{t('color_picker.new')}</small></div>
        <span className="color-picker-sample" style={{ color }}>{t('color_picker.sample')}</span>
      </div>
      <div className="color-picker-channels" dir="ltr">{channels.map(({ channel, label: key, max, unit, background }) => <label key={channel}>
        <span>{t(key)}<output>{Math.round(hsl[channel])}{unit}</output></span>
        <input type="range" min={0} max={max} step={1} value={hsl[channel]} aria-label={t(key)} aria-valuetext={`${Math.round(hsl[channel])}${unit}`}
          style={{ backgroundImage: background }} onChange={event => changeHsl(channel, Number(event.target.value))} />
      </label>)}</div>
      <label className="color-picker-hex">{t('color_picker.hex')}
        <input type="text" dir="ltr" spellCheck={false} autoComplete="off" maxLength={7} value={hexDraft}
          aria-invalid={!valid} aria-describedby={!valid ? errorId : undefined} onChange={event => chooseHex(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (valid) apply(color); } }} />
      </label>
      {!valid && <p id={errorId} className="color-picker-error" role="alert">{t('validation.use_a_six_digit_hex_color')}</p>}
      <div className="color-picker-presets">{presetGroups.map(group => <div role="group" aria-label={t(group.label)} key={group.label}>
        <h3>{t(group.label)}</h3>
        <div className="color-picker-palette">{group.colors.map(preset => <button type="button" key={preset.hex} className="color-picker-preset"
          aria-label={t(preset.name)} title={t(preset.name)} aria-pressed={color === preset.hex && valid} onClick={() => chooseHex(preset.hex)}>
          <span style={{ backgroundColor: preset.hex }} />
        </button>)}</div>
      </div>)}</div>
    </div>
    <footer className="actions color-picker-footer">
      <button type="button" className="secondary" onClick={cancel}>{t('character_import.cancel')}</button>
      <button type="button" disabled={!valid} onClick={() => apply(color)}>{t('color_picker.apply')}</button>
    </footer>
  </dialog>, document.body);
}
