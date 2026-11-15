// The sound panel (DESIGN.md "Sound panel"): the player bar's #sound-btn opens
// #sound-panel, a popover above the bar's right end on desktop and a sheet
// above the bar on phones. It holds the listener's own settings (sound.ts):
// speed, ... Not modal: Escape, the close button, the sound button or a click
// outside closes it, and focus goes back to the sound button.
import { byId } from '../shared/dom.ts';
import { syncRangeFill, t } from '../shared/ui.ts';
import { soundSettings, updateSound, onSoundChange } from './sound.ts';
import { SPEED_STEPS, DEFAULT_SPEED, formatSpeed, speedAt, speedIndex } from './speed-rules.ts';
import { listenState, onListenChange } from '../features/social/listen-along.ts';

const lang = (): string => (window.i18n && window.i18n.getLanguage ? window.i18n.getLanguage() : 'en');

let open = false;

function panel(): HTMLElement { return byId('sound-panel'); }
function button(): HTMLButtonElement { return byId<HTMLButtonElement>('sound-btn'); }

/** Is anything on that changes how music sounds (the button's dot)? */
function effectsActive(): boolean {
  const s = soundSettings();
  return s.speed !== DEFAULT_SPEED;
}

function render(): void {
  const s = soundSettings();
  const following = !!listenState().leader;

  const speed = byId<HTMLInputElement>('sound-speed');
  speed.max = String(SPEED_STEPS.length - 1);
  speed.value = String(speedIndex(s.speed));
  speed.setAttribute('aria-valuetext', formatSpeed(s.speed, lang()));
  syncRangeFill(speed);
  byId('sound-speed-value').textContent = formatSpeed(s.speed, lang());
  byId<HTMLButtonElement>('sound-speed-reset').disabled = s.speed === DEFAULT_SPEED;
  byId('sound-speed-note').hidden = !following;

  const active = effectsActive();
  const btn = button();
  const dot = btn.querySelector<HTMLElement>('[data-sound-dot]');
  if (dot) dot.hidden = !active;
  const label = active ? t('sound.openActive', 'Sound settings (changed)') : t('sound.open', 'Sound settings');
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function onOutside(e: PointerEvent): void {
  const target = e.target as Node | null;
  if (!target || panel().contains(target) || button().contains(target)) return;
  close({ returnFocus: false });
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  e.preventDefault();
  close();
}

export function openSoundPanel(): void {
  if (open) return;
  open = true;
  render();
  panel().hidden = false;
  button().setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey);
  panel().focus();
}

export function close({ returnFocus = true }: { returnFocus?: boolean } = {}): void {
  if (!open) return;
  open = false;
  panel().hidden = true;
  button().setAttribute('aria-expanded', 'false');
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey);
  if (returnFocus) button().focus();
}

/** Call once at start-up (signed-in app). */
export function setupSoundPanel(): void {
  button().addEventListener('click', () => (open ? close() : openSoundPanel()));
  byId('sound-close').addEventListener('click', () => close());

  const speed = byId<HTMLInputElement>('sound-speed');
  speed.addEventListener('input', () => updateSound({ speed: speedAt(speed.value) }));
  byId('sound-speed-reset').addEventListener('click', () => updateSound({ speed: DEFAULT_SPEED }));

  onSoundChange(render);
  onListenChange(render);
  window.addEventListener('languageChanged', render);
  render();
}
