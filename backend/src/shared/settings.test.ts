// The app-wide settings (settings.ts): the REGISTRATIONS_DEFAULT parsing that
// stops the boot on junk, the in-memory mode, and failing closed when the
// database is expected but missing. On Postgres: auth/centralLogin.test.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSettings, parseRegistrationsDefault, SettingsConfigError } from './settings.ts';
import type { SettingsDb } from './settings.ts';

describe('settings', () => {
  it('REGISTRATIONS_DEFAULT: open by default, closed on request, junk refused; a saved value wins', async () => {
    assert.equal(parseRegistrationsDefault({}), true);
    assert.equal(parseRegistrationsDefault({ REGISTRATIONS_DEFAULT: '' }), true);
    assert.equal(parseRegistrationsDefault({ REGISTRATIONS_DEFAULT: 'open' }), true);
    assert.equal(parseRegistrationsDefault({ REGISTRATIONS_DEFAULT: ' Closed ' }), false);
    for (const bad of ['no', 'false', '0', 'off']) assert.throws(() => parseRegistrationsDefault({ REGISTRATIONS_DEFAULT: bad }), SettingsConfigError);
    const noDb: SettingsDb = { isAvailable: () => false, query: async () => { throw new Error('no database'); } };
    const closed = createSettings({ db: noDb, defaults: { registrations_open: false } });
    assert.deepEqual(await closed.read('registrations_open'), { value: false, source: 'default' });
    await closed.set('registrations_open', true);
    assert.deepEqual(await closed.read('registrations_open'), { value: true, source: 'saved' });
    const open = createSettings({ db: noDb, defaults: { registrations_open: true } });
    await open.set('registrations_open', false);
    assert.equal(await open.registrationsOpen(), false, 'saved closed beats env open');
    const expected = createSettings({ db: noDb, dbExpected: true });
    await assert.rejects(expected.registrationsOpen(), /unavailable/, 'no silent default when the database is missing');
  });
});
