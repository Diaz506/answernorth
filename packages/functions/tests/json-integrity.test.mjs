import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUniqueJson } from '../dist/json-integrity.js';

test('rejects duplicate keys at any depth, including escaped aliases', () => {
  for (const raw of ['{"a":1,"a":2}', '{"a":1,"\\u0061":1}', '{"outer":{"x":1,"x":2}}',
    '{"rows":[{"x":1,"x":2}]}']) {
    assert.throws(() => parseUniqueJson(raw));
  }
});

test('accepts distinct keys in separate objects and quoted data without confusing delimiters', () => {
  const raw = '{"rows":[{"x":"a,}\\\\\\"b"},{"x":"other"}],"x":{"x":3}}';
  assert.deepEqual(parseUniqueJson(raw), JSON.parse(raw));
  assert.throws(() => parseUniqueJson('{"x":1} trailing'));
  assert.throws(() => parseUniqueJson('['.repeat(33) + '0' + ']'.repeat(33)));
});
