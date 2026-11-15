// The sound panel (DESIGN.md "Sound panel"): the player bar's #sound-btn opens
// #sound-panel, a popover above the bar's right end on desktop and a sheet
// above the bar on phones. It holds the listener's own settings (sound.ts):
// speed, and the sleep timer (sleep-timer.ts, not a stored setting). Not
// modal: Escape, the close button, the sound button or a click outside
// closes it, and focus goes back to the sound button.
import { byId } from '../shared/dom.ts';
import { syncRangeFill, t } from '../shared/ui.ts';
import { soundSettings, updateSound, onSoundChange } from './sound.ts';
import { SPEED_STEPS, DEFAULT_SPEED, formatSpeed, speedAt, speedIndex } from './speed-rules.ts';
import { listenState, onListenChange } from '../features/social/listen-along.ts';
import { sleepTimer, sleepIn, sleepAtEndOfSong, cancelSleep, onSleepChange } from './sleep-timer.ts';
import { formatCountdown, parseCustomMinutes, remainingMs, MAX_CUSTOM_MIN } from './sleep-timer-rules.ts';

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

  renderSleep();

  const active = effectsActive();
  const sleeping = sleepTimer().kind !== 'off';
  const btn = button();
  const dot = btn.querySelector<HTMLElement>('[data-sound-dot]');
  if (dot) dot.hidden = !active;
  const moon = btn.querySelector<SVGElement>('[data-sound-sleep]');
  if (moon) moon.toggleAttribute('hidden', !sleeping);
  let label = active ? t('sound.openActive', 'Sound settings (changed)') : t('sound.open', 'Sound settings');
  if (sleeping) label += ` · ${sleepStatus()}`;
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function sleepStatus(): string {
  const timer = sleepTimer();
  if (timer.kind === 'end-of-song') return t('sound.sleepAtEnd', 'Stops at the end of this song');
  if (timer.kind === 'at') return tf('sound.sleepIn', 'Stops in {time}', { time: formatCountdown(remainingMs(timer, Date.now())) });
  return t('sound.sleepOff', 'Off');
}

function renderSleep(): void {
  const timer = sleepTimer();
  byId('sound-sleep-status').textContent = sleepStatus();
  byId('sound-sleep-cancel').hidden = timer.kind === 'off';
  for (const b of panel().querySelectorAll<HTMLButtonElement>('[data-sleep]')) {
    const v = b.dataset.sleep;
    if (v !== 'end') b.textContent = tf('sound.minutes', '{n} min', { n: Number(v) });
    const pressed = v === 'end' ? timer.kind === 'end-of-song' : timer.kind === 'at' && timer.minutes === Number(v);
    b.setAttribute('aria-pressed', String(pressed));
  }
}

// t() with {placeholders} filled in the fallback too (t returns it raw).
const tf = (key: string, fallback: string, vars: Record<string, string | number>): string =>
  t(key, fallback, vars).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

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

  for (const b of panel().querySelectorAll<HTMLButtonElement>('[data-sleep]')) {
    b.addEventListener('click', () => {
      const v = b.dataset.sleep;
      if (v === 'end') sleepAtEndOfSong();
      else sleepIn(Number(v));
    });
  }
  // Cancel hides itself: focus moves to the first choice.
  byId('sound-sleep-cancel').addEventListener('click', () => { cancelSleep(); panel().querySelector<HTMLButtonElement>('[data-sleep]')?.focus(); });
  const custom = byId<HTMLFormElement>('sound-sleep-custom');
  const minutes = byId<HTMLInputElement>('sound-sleep-minutes');
  const error = byId('sound-sleep-error');
  custom.addEventListener('submit', (e) => {
    e.preventDefault();
    const m = parseCustomMinutes(minutes.value);
    if (m === null) {
      error.textContent = tf('sound.sleepInvalid', 'Enter 1 to {max} minutes, or hours:minutes like 1:30.', { max: MAX_CUSTOM_MIN });
      error.hidden = false;
      minutes.setAttribute('aria-invalid', 'true');
      return;
    }
    error.hidden = true;
    minutes.removeAttribute('aria-invalid');
    minutes.value = '';
    sleepIn(m);
  });
  minutes.addEventListener('input', () => { error.hidden = true; minutes.removeAttribute('aria-invalid'); });
  onSleepChange(render);

  onSoundChange(render);
  onListenChange(render);
  window.addEventListener('languageChanged', render);
  render();
}
