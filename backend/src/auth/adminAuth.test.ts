// The /dashboard cookie (adminAuth.ts): the password and username checks and
// the signed, expiring session value.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as adminAuth from './adminAuth.ts';

describe('adminAuth', () => {
  let saved: string | undefined;
  let savedUser: string | undefined;
  beforeEach(() => { saved = process.env.ADMIN_PASSWORD; savedUser = process.env.ADMIN_USER; });
  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = saved;
    if (savedUser === undefined) delete process.env.ADMIN_USER; else process.env.ADMIN_USER = savedUser;
  });

  it('is disabled without ADMIN_PASSWORD', () => {
    delete process.env.ADMIN_PASSWORD;
    assert.equal(adminAuth.isEnabled(), false);
    assert.equal(adminAuth.checkPassword(''), false);
    assert.equal(adminAuth.verifySessionValue('123.abc'), false);
  });

  it('checks the password and signs expiring sessions', () => {
    process.env.ADMIN_PASSWORD = 'hunter2';
    assert.equal(adminAuth.checkPassword('hunter2'), true);
    assert.equal(adminAuth.checkPassword('hunter3'), false);
    const now = Date.now();
    const v = adminAuth.createSessionValue(now);
    assert.equal(adminAuth.verifySessionValue(v, now), true);
    assert.equal(adminAuth.verifySessionValue(v, now + 8 * 24 * 3600 * 1000), false, 'expired');
    const [exp, sig] = v.split('.');
    assert.equal(adminAuth.verifySessionValue(`${Number(exp) + 1}.${sig}`, now), false, 'tampered');
    process.env.ADMIN_PASSWORD = 'changed';
    assert.equal(adminAuth.verifySessionValue(v, now), false, 'password change logs out');
  });

  it('checks the username, defaulting to admin', () => {
    delete process.env.ADMIN_USER;
    process.env.ADMIN_PASSWORD = 'hunter2';
    assert.equal(adminAuth.checkCredentials('admin', 'hunter2'), true);
    assert.equal(adminAuth.checkCredentials('root', 'hunter2'), false);
    assert.equal(adminAuth.checkCredentials(undefined, 'hunter2'), false);
    const now = Date.now();
    const v = adminAuth.createSessionValue(now);
    process.env.ADMIN_USER = 'erkan';
    assert.equal(adminAuth.checkCredentials('erkan', 'hunter2'), true);
    assert.equal(adminAuth.checkCredentials('admin', 'hunter2'), false);
    assert.equal(adminAuth.checkCredentials('erkan', 'hunter3'), false);
    assert.equal(adminAuth.verifySessionValue(v, now), false, 'username change logs out');
  });
});
