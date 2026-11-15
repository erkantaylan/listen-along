// CLI tokens (tokens.ts) without a database: the token shape, the hash, and
// reading the Authorization header.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import * as tokens from './tokens.ts';

describe('tokens helpers', () => {
  it('generates distinct prefixed tokens and hashes deterministically', () => {
    const a = tokens.generateToken();
    const b = tokens.generateToken();
    assert.notEqual(a, b);
    assert.match(a, /^la_[A-Za-z0-9_-]{43}$/);
    assert.equal(tokens.hashToken(a), tokens.hashToken(a));
    assert.match(tokens.hashToken(a), /^[0-9a-f]{64}$/);
  });

  it('parses Bearer headers', () => {
    assert.equal(tokens.bearerFrom({ headers: { authorization: 'Bearer abc' } }), 'abc');
    assert.equal(tokens.bearerFrom({ headers: { authorization: 'bearer   abc ' } }), 'abc');
    assert.equal(tokens.bearerFrom({ headers: { authorization: 'Basic abc' } }), null);
    assert.equal(tokens.bearerFrom({ headers: {} }), null);
  });

  it('optionalToken ignores non-Bearer Authorization (cached browser Basic auth)', () => {
    let passed = false;
    const res = { status() { throw new Error('should not respond'); } } as unknown as Response;
    tokens.optionalToken({ headers: { authorization: 'Basic YWRtaW46cHc=' } } as Request, res, () => { passed = true; });
    assert.equal(passed, true);
    assert.equal(tokens.hasBearer({ headers: { authorization: 'Bearer x' } }), true);
    assert.equal(tokens.hasBearer({ headers: { authorization: 'Basic x' } }), false);
  });
});
