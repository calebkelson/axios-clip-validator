import test from 'node:test';
import assert from 'node:assert/strict';
import { fallbackSearchPlan, normalizeSearchText, tokenizeSearchQuery } from './search.js';

test('search terms preserve exact names and remove filler words', () => {
  assert.equal(normalizeSearchText('  what   about Nvidia?  '), 'what about Nvidia?');
  assert.deepEqual(tokenizeSearchQuery('what about Nvidia chips'), ['nvidia', 'chips']);
});

test('fallback expansion adds useful related terms without changing the exact query', () => {
  const plan = fallbackSearchPlan('Nvidia');
  assert.equal(plan.exactPhrase, 'Nvidia');
  assert.deepEqual(plan.exactTerms, ['nvidia']);
  assert.ok(plan.relatedTerms.includes('gpu'));
  assert.ok(plan.relatedTerms.includes('semiconductors'));
  assert.equal(plan.source, 'fallback');
});
