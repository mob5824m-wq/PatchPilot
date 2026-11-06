import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, looksExperimental, sortVersionsDescending } from '../src/core/versions.ts';

test('compares numeric segments numerically, not lexically', () => {
  assert.ok(compareVersions('21.10.1', '21.9.4') > 0);
  assert.ok(compareVersions('1.2.3', '1.2.10') < 0);
  assert.equal(compareVersions('21.43.523', '21.43.523'), 0);
});

test('handles four-part and prefixed versions', () => {
  assert.ok(compareVersions('26.30.05', '26.9.05') > 0);
  assert.ok(compareVersions('407.0.0.178994', '407.0.0.178993') > 0);
  assert.ok(compareVersions('Android V1.79.3', '1.78.0') > 0);
  assert.ok(compareVersions('a3.77.2', 'a3.77.1') > 0);
});

test('treats a numeric segment as newer than an alphanumeric one', () => {
  assert.ok(compareVersions('1.2', '1.beta') > 0);
});

test('sorts newest first', () => {
  assert.deepEqual(sortVersionsDescending(['1.9.0', '1.10.0', '1.2.0']), ['1.10.0', '1.9.0', '1.2.0']);
});

test('spots pre-release version strings', () => {
  assert.ok(looksExperimental('2.1.0-dev.9'));
  assert.ok(looksExperimental('1.0.0-beta2'));
  assert.ok(!looksExperimental('21.43.523'));
});
