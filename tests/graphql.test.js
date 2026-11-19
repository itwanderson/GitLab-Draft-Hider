import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load.js';

const G = loadGlobal('graphql.js', 'GDHGraphql');

const page = (nodes, hasNextPage = false, endCursor = null) => ({
  data: { project: { mergeRequests: { pageInfo: { hasNextPage, endCursor }, nodes } }, group: null },
});

const node = (iid, path = 'g/p') => ({
  iid,
  title: `MR ${iid}`,
  webUrl: `https://gitlab.com/${path}/-/merge_requests/${iid}`,
  draft: iid === 1,
  updatedAt: '2026-01-01T00:00:00Z',
  author: { username: 'ana' },
  project: { fullPath: path },
  labels: { nodes: [{ title: 'backend' }] },
});

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Map([['content-type', 'application/json']]),
  text: async () => JSON.stringify(body),
});

test('builds variables and omits empty filters', () => {
  assert.deepEqual(G.buildVariables({ path: 'g/p', filters: { labels: ['a'], draft: 'yes' }, after: 'c1' }),
    { fullPath: 'g/p', after: 'c1', labels: ['a'], draft: true });
  assert.deepEqual(G.buildVariables({ path: 'g/p', filters: {}, after: null }), { fullPath: 'g/p' });
});

test('maps a scope filter onto the matching username argument', () => {
  assert.deepEqual(G.buildVariables({ path: 'g/p', filters: { scope: 'assigned_to_me' }, after: null, me: 'ana' }),
    { fullPath: 'g/p', assignees: ['ana'] });
  assert.deepEqual(G.buildVariables({ path: 'g/p', filters: { scope: 'reviews_for_me' }, after: null, me: 'ana' }),
    { fullPath: 'g/p', reviewer: 'ana' });
});

test('maps nodes and keeps the project path with the iid', () => {
  const r = G.mapResponse(page([node(1), node(2, 'g/other')]));
  assert.equal(r.scope, 'project');
  assert.deepEqual(r.entries[0], {
    path: 'g/p', iid: 1, title: 'MR 1',
    webUrl: 'https://gitlab.com/g/p/-/merge_requests/1', draft: true, labels: ['backend'],
    author: 'ana', updatedAt: '2026-01-01T00:00:00Z',
  });
  assert.equal(r.entries[1].path, 'g/other');
});

test('reports null scope when neither project nor group answers', () => {
  assert.deepEqual(G.mapResponse({ data: { project: null, group: null } }),
    { scope: null, entries: [], hasNextPage: false, endCursor: null });
});

test('treats an HTML response as signed out', () => {
  assert.equal(G.classifyError({ status: 200, contentType: 'text/html', body: '<html>sign in</html>' }).kind, 'signed-out');
  assert.equal(G.classifyError({ status: 401, contentType: 'application/json', body: '{}' }).kind, 'signed-out');
  assert.equal(G.classifyError({ status: 429 }).kind, 'rate-limited');
  assert.equal(G.classifyError({ status: 200, contentType: 'application/json', body: JSON.stringify({ errors: [{ message: 'x' }] }) }).kind, 'schema');
});

test('pages until hasNextPage is false', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body).variables.after);
    const body = calls.length === 1 ? page([node(1)], true, 'c1') : page([node(2)]);
    return jsonResponse(body);
  };
  const r = await G.createClient({ fetchImpl, endpoint: 'https://x/api/graphql', csrfToken: 't' })
    .fetchAll({ path: 'g/p', filters: {} });
  assert.deepEqual(calls, [undefined, 'c1']);
  assert.deepEqual(r.entries.map((e) => e.iid), [1, 2]);
  assert.equal(r.truncated, false);
});

test('stops at maxPages and reports truncation', async () => {
  const fetchImpl = async () => jsonResponse(page([node(3)], true, 'next'));
  const r = await G.createClient({ fetchImpl, endpoint: 'https://x/api/graphql', csrfToken: 't', maxPages: 3 })
    .fetchAll({ path: 'g/p', filters: {} });
  assert.equal(r.entries.length, 3);
  assert.equal(r.truncated, true);
});

test('sends the CSRF header and same-origin credentials', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonResponse(page([node(1)]));
  };
  await G.createClient({ fetchImpl, endpoint: 'https://x/api/graphql', csrfToken: 'tok' })
    .fetchAll({ path: 'g/p', filters: {} });
  assert.equal(seen.url, 'https://x/api/graphql');
  assert.equal(seen.init.credentials, 'same-origin');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['X-CSRF-Token'], 'tok');
});
