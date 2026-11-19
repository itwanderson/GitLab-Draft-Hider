import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load.js';

loadGlobal('classify.js', 'GDHClassify');
loadGlobal('hosts.js', 'GDHHosts');
const R = loadGlobal('reconcile.js', 'GDHReconcile');

const cfg = { hideDrafts: true, labels: ['dependencies'] };

const row = (path, iid, extra = {}) => ({
  path, iid, title: `MR ${iid}`, href: `https://gitlab.com/${path}/-/merge_requests/${iid}`,
  draft: false, labels: [], ...extra,
});
const entry = (path, iid, extra = {}) => ({
  path, iid, title: `MR ${iid}`, webUrl: `https://gitlab.com/${path}/-/merge_requests/${iid}`,
  draft: false, labels: [], ...extra,
});

test('hides drafts and configured labels from page rows', () => {
  const r = R.pagePass([
    row('g/p', 1, { draft: true }),
    row('g/p', 2, { labels: ['dependencies'] }),
    row('g/p', 3),
  ], cfg);
  assert.deepEqual([...r.hide].sort(), ['g/p!1', 'g/p!2']);
  assert.deepEqual(r.items.map((i) => [i.iid, i.reasons]), [[1, ['draft']], [2, ['label:dependencies']]]);
});

test('keeps identical iids in different projects separate', () => {
  const r = R.sessionPass([
    entry('g/a', 12, { draft: true }),
    entry('g/b', 12, { labels: ['dependencies'] }),
    entry('g/c', 12),
  ], cfg);
  assert.deepEqual([...r.hide].sort(), ['g/a!12', 'g/b!12']);
  assert.deepEqual(r.items.map((i) => i.path), ['g/a', 'g/b']);
});

test('unions both passes and de-duplicates items by key', () => {
  const page = R.pagePass([row('g/p', 1, { draft: true })], cfg);
  const session = R.sessionPass([entry('g/p', 1, { draft: true })], cfg);
  const m = R.merge(page, session, { unknownFilters: [] });
  assert.deepEqual([...m.hide], ['g/p!1']);
  assert.equal(m.items.length, 1);
  assert.equal(m.countDelta, 1);
});

test('keeps a page-only hidden MR in the tab when the session answer lacks it', () => {
  const page = R.pagePass([row('g/p', 9, { draft: true })], cfg);
  const session = R.sessionPass([], cfg);
  const m = R.merge(page, session, { unknownFilters: [] });
  assert.deepEqual([...m.hide], ['g/p!9']);
  assert.equal(m.items.length, 1);
  assert.equal(m.countDelta, 0);
});

test('skips count correction when filters are unknown', () => {
  const session = R.sessionPass([entry('g/p', 1, { draft: true })], cfg);
  assert.equal(R.merge(R.pagePass([], cfg), session, { unknownFilters: ['timeframe'] }).countDelta, 0);
  assert.equal(R.merge(R.pagePass([], cfg), session, { unknownFilters: [] }).countDelta, 1);
});
