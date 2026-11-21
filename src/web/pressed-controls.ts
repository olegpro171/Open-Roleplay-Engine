const pressable = 'button, summary, a[href], [role="option"], input:is([type="checkbox"], [type="radio"]), label';

function pressTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return null;
  const control = target.closest(pressable);
  if (!control || control.matches(':disabled, [aria-disabled="true"], .topbar .tabs > button')) return null;
  if (control instanceof HTMLLabelElement) {
    return control.control?.matches('input:is([type="checkbox"], [type="radio"]):enabled') ? control : null;
  }
  if (control instanceof HTMLInputElement) return control.closest('label') ?? control;
  return control;
}

export function trackPressedControls() {
  let press: { control: Element; pointerId: number; x: number; y: number } | null = null;

  function clear() {
    press?.control.removeAttribute('data-pointer-pressed');
    press = null;
  }

  const capture = { capture: true, passive: true };
  document.addEventListener('pointerdown', event => {
    clear(); // A second finger can start a pinch.
    if (!event.isPrimary || event.button !== 0) return;
    const control = pressTarget(event.target);
    if (!control) return;
    press = { control, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    control.setAttribute('data-pointer-pressed', '');
  }, capture);
  document.addEventListener('pointermove', event => {
    if (event.pointerId !== press?.pointerId) return;
    if (event.pointerType === 'mouse') {
      press.control.toggleAttribute('data-pointer-pressed', pressTarget(event.target) === press.control);
    } else if (Math.hypot(event.clientX - press.x, event.clientY - press.y) >= 8) {
      // A swipe can move before the browser takes over and sends pointercancel.
      clear();
    }
  }, capture);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    document.addEventListener(type, event => {
      if (event.pointerId === press?.pointerId) clear();
    }, capture);
  }
  document.addEventListener('pointerout', event => {
    if (event.pointerId === press?.pointerId && event.relatedTarget === null) clear();
  }, capture);
  document.addEventListener('contextmenu', clear, capture);
  window.addEventListener('blur', clear);
}
