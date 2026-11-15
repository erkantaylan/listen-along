/**
 * Small app-wide switches an admin changes at run time (no restart), stored in
 * Postgres `app_settings` (key -> JSON value); in memory without a database,
 * like the other stores.
 *
 *   registrations_open  boolean. When false, a central-login identity that
 *                       matches no existing account is not given a new one
 *                       (oidcLink.js). Existing accounts are unaffected. Only
 *                       central login reads it.
 *
 * Until an admin has saved a setting, its value comes from the environment:
 * REGISTRATIONS_DEFAULT=open|closed (default open; anything else stops the
 * boot). Once saved (dashboard), the stored value wins and the env var is
 * ignored. Read on every use (a single-row lookup), so a change applies at once.
 */
import type { Db } from './types.ts';

export class SettingsConfigError extends Error {}

/** Every setting and its type. */
export interface SettingValues {
  registrations_open: boolean;
}
export type SettingKey = keyof SettingValues;

/** A setting's value and where it came from. */
export interface SettingRead<K extends SettingKey = SettingKey> {
  value: SettingValues[K];
  source: 'saved' | 'default';
}

/** What the store uses of the database (shared/db.ts). */
export type SettingsDb = Pick<Db, 'isAvailable' | 'query'>;

export interface Settings {
  /** @throws for an unknown key, or when the database is expected but missing */
  read<K extends SettingKey>(key: K): Promise<SettingRead<K>>;
  get<K extends SettingKey>(key: K): Promise<SettingValues[K]>;
  /** @throws TypeError when the value's type is not the setting's */
  set<K extends SettingKey>(key: K, value: SettingValues[K]): Promise<SettingValues[K]>;
  registrationsOpen(): Promise<boolean>;
}

/** REGISTRATIONS_DEFAULT -> boolean (registrations open). @throws SettingsConfigError */
export function parseRegistrationsDefault(env: Record<string, string | undefined> = process.env): boolean {
  const raw = typeof env.REGISTRATIONS_DEFAULT === 'string' ? env.REGISTRATIONS_DEFAULT.trim().toLowerCase() : '';
  if (raw === '' || raw === 'open') return true;
  if (raw === 'closed') return false;
  throw new SettingsConfigError(`REGISTRATIONS_DEFAULT must be "open" or "closed" (got "${env.REGISTRATIONS_DEFAULT}")`);
}

/**
 * @param dbExpected DATABASE_URL is set: a missing pool is an outage (reads
 *   and writes fail) rather than the no-database mode
 * @param defaults   { registrations_open } from the environment
 */
export function createSettings({ db, dbExpected = false, defaults = {} }: {
  db: SettingsDb | null;
  dbExpected?: boolean;
  defaults?: Partial<SettingValues>;
}): Settings {
  const DEFAULTS: SettingValues = { registrations_open: true, ...defaults };
  const memory = new Map<SettingKey, SettingValues[SettingKey]>();
  const usePg = () => {
    if (db && db.isAvailable()) return true;
    if (dbExpected) throw new Error('the database is unavailable');
    return false;
  };

  /** { value, source: 'saved' | 'default' } */
  async function read<K extends SettingKey>(key: K): Promise<SettingRead<K>> {
    if (!(key in DEFAULTS)) throw new Error(`unknown setting ${key}`);
    if (!usePg()) return memory.has(key) ? { value: memory.get(key) as SettingValues[K], source: 'saved' } : { value: DEFAULTS[key], source: 'default' };
    const r = await db!.query<{ value: SettingValues[K] }>('SELECT value FROM app_settings WHERE key = $1', [key]);
    return r.rows[0] ? { value: r.rows[0].value, source: 'saved' } : { value: DEFAULTS[key], source: 'default' };
  }

  async function get<K extends SettingKey>(key: K): Promise<SettingValues[K]> {
    return (await read(key)).value;
  }

  async function set<K extends SettingKey>(key: K, value: SettingValues[K]): Promise<SettingValues[K]> {
    if (!(key in DEFAULTS)) throw new Error(`unknown setting ${key}`);
    if (typeof value !== typeof DEFAULTS[key]) throw new TypeError(`${key} must be a ${typeof DEFAULTS[key]}`);
    if (!usePg()) { memory.set(key, value); return value; }
    await db!.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [key, JSON.stringify(value), Date.now()]
    );
    return value;
  }

  const registrationsOpen = async () => (await get('registrations_open')) !== false;

  return { read, get, set, registrationsOpen };
}
