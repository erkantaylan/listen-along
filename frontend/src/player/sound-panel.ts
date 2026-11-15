// The sound panel (DESIGN.md "Sound panel"): the player bar's #sound-btn opens
// #sound-panel, a popover above the bar's right end on desktop and a sheet
// above the bar on phones. It holds the listener's own settings (sound.ts):
// speed, the sleep timer (sleep-timer.ts, not a stored setting), the
// equalizer and the volume boost (audio-graph.ts). Not
// modal: Escape, the close button, the sound button or a click outside
// closes it, and focus goes back to the sound button.
import { byId } from '../shared/dom.ts';
import { syncRangeFill, t } from '../shared/ui.ts';
import { soundSettings, updateSound, onSoundChange } from './sound.ts';
import { SPEED_STEPS, DEFAULT_SPEED, formatSpeed, speedAt, speedIndex } from './speed-rules.ts';
import { listenState, onListenChange } from '../features/social/listen-along.ts';
import { sleepTimer, sleepIn, sleepAtEndOfSong, cancelSleep, onSleepChange } from './sleep-timer.ts';
import { formatCountdown, parseCustomMinutes, remainingMs, MAX_CUSTOM_MIN } from './sleep-timer-rules.ts';
import { EQ_BANDS, EQ_MAX_DB, EQ_MIN_DB, EQ_STEP_DB, BOOST_MAX, BOOST_STEP, formatBand, formatDb, gainsFor, isEqChoice, normalizeBoost, withBand } from './equalizer-rules.ts';
import { effectsAllowed, effectsStatus, isMobileDevice, onGraphChange, primeAudioGraph } from './audio-graph.ts';

const lang = (): string => (window.i18n && window.i18n.getLanguage ? window.i18n.getLanguage() : 'en');

let open = false;

function panel(): HTMLElement { return byId('sound-panel'); }
function button(): HTMLButtonElement { return byId<HTMLButtonElement>('sound-btn'); }

/** Is anything on that changes how music sounds (the button's dot)? */
function effectsActive(): boolean {
  const s = soundSettings();
  const fx = effectsStatus();
  return s.speed !== DEFAULT_SPEED || fx === 'on' || fx === 'waiting';
}

function bandsHtml(): string {
  return EQ_BANDS.map((hz, i) => `
    <div class="sound-band">
      <span class="sound-band-hz" aria-hidden="true">${formatBand(hz)}</span>
      <div class="form-range"><input type="range" class="form-range-input" data-band="${i}" min="${EQ_MIN_DB}" max="${EQ_MAX_DB}" step="${EQ_STEP_DB}" value="0" aria-label="${hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`}"></div>
      <span class="sound-band-db" data-band-db="${i}" aria-hidden="true">0 dB</span>
    </div>`).join('');
}

function renderEffects(): void {
  const s = soundSettings();
  const mobile = isMobileDevice();
  const allowed = effectsAllowed();
  byId('sound-mobile').hidden = !mobile;
  byId<HTMLInputElement>('sound-mobile-on').checked = s.effectsOnMobile;

  const on = byId<HTMLInputElement>('sound-eq-on');
  on.checked = s.eqOn;
  on.disabled = !allowed;
  const preset = byId<HTMLSelectElement>('sound-eq-preset');
  preset.value = s.eqPreset;
  preset.disabled = !allowed;
  const gains = gainsFor(s.eqPreset, s.eqCustom);
  byId<HTMLButtonElement>('sound-eq-reset').disabled = !allowed || gains.every((g) => g === 0);
  const bands = byId('sound-eq-bands');
  bands.classList.toggle('is-off', !s.eqOn);
  for (const input of bands.querySelectorAll<HTMLInputElement>('[data-band]')) {
    const i = Number(input.dataset.band);
    const g = gains[i];
    if (document.activeElement !== input || Number(input.value) !== g) input.value = String(g);
    input.disabled = !allowed;
    input.setAttribute('aria-valuetext', formatDb(g, lang()));
    const pos = ((g - EQ_MIN_DB) / (EQ_MAX_DB - EQ_MIN_DB)) * 100;
    input.style.setProperty('--band-lo', `${Math.min(50, pos)}%`);
    input.style.setProperty('--band-hi', `${Math.max(50, pos)}%`);
    const label = bands.querySelector(`[data-band-db="${i}"]`);
    if (label) label.textContent = formatDb(g, lang());
  }

  const boost = byId<HTMLInputElement>('sound-boost');
  boost.max = String(BOOST_MAX);
  boost.step = String(BOOST_STEP);
  boost.value = String(s.boost);
  boost.disabled = !allowed;
  boost.setAttribute('aria-valuetext', `+${s.boost}%`);
  syncRangeFill(boost);
  byId('sound-boost-value').textContent = `+${s.boost}%`;
  byId<HTMLButtonElement>('sound-boost-reset').disabled = !allowed || s.boost === 0;

  const status = byId('sound-effects-status');
  const fx = effectsStatus();
  const text = fx === 'unsupported' ? t('sound.fxUnsupported', 'This browser cannot apply the equalizer or the boost.')
    : fx === 'blocked' ? t('sound.fxBlocked', 'The equalizer and the boost are off on this device.')
      : fx === 'waiting' ? t('sound.fxWaiting', 'The effects start with your next tap or key press.')
        : '';
  status.textContent = text;
  status.hidden = !text;
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
  renderEffects();

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

  // Equalizer and boost. Every change here is a user gesture: the audio
  // context may start now (audio-graph.ts).
  const bands = byId('sound-eq-bands');
  bands.innerHTML = bandsHtml();
  const fx = (patch: Parameters<typeof updateSound>[0]) => { updateSound(patch); primeAudioGraph(); };
  byId<HTMLInputElement>('sound-mobile-on').addEventListener('change', (e) => fx({ effectsOnMobile: (e.target as HTMLInputElement).checked }));
  byId<HTMLInputElement>('sound-eq-on').addEventListener('change', (e) => fx({ eqOn: (e.target as HTMLInputElement).checked }));
  byId<HTMLSelectElement>('sound-eq-preset').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    // Choosing a preset turns the equalizer on.
    if (isEqChoice(v)) fx({ eqPreset: v, eqOn: true });
  });
  bands.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.band) return;
    const s = soundSettings();
    fx({ ...withBand(s.eqPreset, s.eqCustom, Number(input.dataset.band), Number(input.value)), eqOn: true });
  });
  byId('sound-eq-reset').addEventListener('click', () => fx({ eqPreset: 'flat' }));
  const boost = byId<HTMLInputElement>('sound-boost');
  boost.addEventListener('input', () => fx({ boost: normalizeBoost(boost.value) }));
  byId('sound-boost-reset').addEventListener('click', () => fx({ boost: 0 }));
  onGraphChange(render);

  onSoundChange(render);
  onListenChange(render);
  window.addEventListener('languageChanged', render);
  render();
}
