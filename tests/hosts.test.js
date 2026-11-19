import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load.js';

const H = loadGlobal('hosts.js', 'GDHHosts');

test('normalises hosts with and without an install subpath', () => {
  assert.deepEqual(H.normalizeBaseUrl('https://gitlab.com/'), { origin: 'https://gitlab.com', prefix: '' });
  assert.deepEqual(H.normalizeBaseUrl(' https://example.com/gitlab/ '), { origin: 'https://example.com', prefix: '/gitlab' });
  assert.equal(H.normalizeBaseUrl('ftp://x'), null);
  assert.equal(H.normalizeBaseUrl('not a url'), null);
});

test('parses project, group and subgroup lists, and refuses detail pages', () => {
  const base = { origin: 'https://gitlab.com', prefix: '' };
  assert.equal(H.isMergeRequestListUrl('https://gitlab.com/g/p/-/merge_requests', base), true);
  assert.equal(H.isMergeRequestListUrl('https://gitlab.com/g/p/-/merge_requests/12', base), false);
  assert.deepEqual(H.parseListUrl('https://gitlab.com/g/sub/p/-/merge_requests', base).path, 'g/sub/p');
  assert.equal(H.parseListUrl('https://gitlab.com/g/p/issues', base), null);
});

test('isolates the subpath install from the scope path', () => {
  const base = { origin: 'https://example.com', prefix: '/gitlab' };
  const r = H.parseListUrl('https://example.com/gitlab/mygroup/proj/-/merge_requests?state=opened', base);
  assert.equal(r.path, 'mygroup/proj');
  assert.equal(H.graphqlUrl(base), 'https://example.com/gitlab/api/graphql');
  assert.equal(H.matchPattern(base), 'https://example.com/gitlab/*');
  assert.deepEqual(H.identityFromHref('https://example.com/gitlab/mygroup/proj/-/merge_requests/12', base),
    { path: 'mygroup/proj', iid: 12 });
});

test('maps filters and flags the ones it does not understand', () => {
  const base = { origin: 'https://gitlab.com', prefix: '' };
  const r = H.parseListUrl('https://gitlab.com/g/p/-/merge_requests?state=all&label_name[]=dependencies&label_name[]=do-not-merge&author_username=ana&search=login&sort=created_date&timeframe=month', base);
  assert.equal(r.state, 'all');
  assert.deepEqual(r.filters.labels, ['dependencies', 'do-not-merge']);
  assert.equal(r.filters.author, 'ana');
  assert.equal(r.filters.search, 'login');
  assert.deepEqual(r.unknownFilters, ['timeframe']);
});

test('resolves the base for a page from the configured hosts', () => {
  const hosts = [{ url: 'https://example.com/gitlab' }, { url: 'https://example.com/gitlab/deep' }];
  assert.deepEqual(H.resolveBase('https://example.com/gitlab/deep/g/p/-/merge_requests', hosts),
    { origin: 'https://example.com', prefix: '/gitlab/deep' });
  assert.equal(H.resolveBase('https://example.com/gitlabx/g/p/-/merge_requests', hosts), null);
  assert.deepEqual(H.resolveBase('https://gitlab.com/g/p/-/merge_requests', []),
    { origin: 'https://gitlab.com', prefix: '' });
});

test('builds stable, legal registration ids', () => {
  assert.equal(H.registrationFor({ origin: 'https://example.com', prefix: '/gitlab' }).id, 'gdh-https-example-com-gitlab');
  assert.equal(H.registrationFor({ origin: 'https://gitlab.com', prefix: '' }).id, 'gdh-https-gitlab-com');
});
