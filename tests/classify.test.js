import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load.js';

const { isDraftTitle, matchLabels, classify } = loadGlobal('classify.js', 'GDHClassify');

test('recognises GitLab draft prefixes', () => {
  for (const t of ['DRAFT: fix', 'Draft: fix', '[Draft] fix', '(draft) fix', 'WIP: fix', '[WIP] fix']) {
    assert.equal(isDraftTitle(t), true, t);
  }
});

test('does not treat Drafting as a draft', () => {
  for (const t of ['Drafting the plan', 'WIPping up', 'Redraft: maybe', 'fix: draft handling']) {
    assert.equal(isDraftTitle(t), false, t);
  }
});

test('matches labels exactly', () => {
  assert.deepEqual(matchLabels(['Dependencies', 'backend'], ['dependencies']), ['Dependencies']);
  assert.deepEqual(matchLabels(['dependencies-java'], ['dependencies']), []);
  assert.deepEqual(matchLabels(['  Do-Not-Merge '], ['do-not-merge']), ['  Do-Not-Merge ']);
});

test('classify reports draft and label reasons, draft first', () => {
  const r = classify({ draft: true, labels: ['on-hold', 'dependencies'] },
                      { hideDrafts: true, labels: ['dependencies', 'on-hold'] });
  assert.deepEqual(r, { hidden: true, reasons: ['draft', 'label:dependencies', 'label:on-hold'] });
});

test('classify keeps parked MRs visible when nothing matches', () => {
  assert.deepEqual(classify({ draft: false, labels: ['backend'] }, { hideDrafts: true, labels: ['dependencies'] }),
                   { hidden: false, reasons: [] });
  assert.deepEqual(classify({ draft: true, labels: [] }, { hideDrafts: false, labels: [] }),
                   { hidden: false, reasons: [] });
});
