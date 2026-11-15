// The secret boxes (secretBox.ts) that keep the central login's tokens at rest
// and its flow cookie: bound to key, purpose and context.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as secretBox from './secretBox.ts';

describe('secretBox', () => {
  it('secret boxes open only with the same key and context', () => {
    const k = secretBox.deriveKey('secret', 'purpose-a');
    const box = secretBox.seal(k, 'refresh-token-value', 'row-1');
    assert.ok(box);
    assert.doesNotMatch(box, /refresh-token-value/);
    assert.equal(secretBox.open(k, box, 'row-1'), 'refresh-token-value');
    assert.equal(secretBox.open(k, box, 'row-2'), null, 'bound to its row');
    assert.equal(secretBox.open(secretBox.deriveKey('secret', 'purpose-b'), box, 'row-1'), null, 'bound to its purpose');
    assert.equal(secretBox.open(secretBox.deriveKey('other', 'purpose-a'), box, 'row-1'), null, 'bound to the secret');
    const parts = box.split('.');
    parts[2] = Buffer.from('x'.repeat(19)).toString('base64url');
    assert.equal(secretBox.open(k, parts.join('.'), 'row-1'), null, 'tampering is detected');
    assert.notEqual(secretBox.seal(k, 'same', 'r'), secretBox.seal(k, 'same', 'r'), 'random IV');
  });
});
