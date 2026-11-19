import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { loadGlobal } from './helpers/load.js';

loadGlobal('classify.js', 'GDHClassify');
loadGlobal('hosts.js', 'GDHHosts');
loadGlobal('dom.js', 'GDHDom');
loadGlobal('reconcile.js', 'GDHReconcile');
loadGlobal('graphql.js', 'GDHGraphql');
const run = loadGlobal('../content/content.js', 'GDHRun');

const html = readFileSync(new URL('./fixtures/list.html', import.meta.url), 'utf8');
const href = 'https://gitlab.com/g/p/-/merge_requests?state=opened';

const node = (iid, extra = {}) => ({
  iid,
  title: `MR ${iid}`,
  webUrl: `https://gitlab.com/g/p/-/merge_requests/${iid}`,
  draft: false,
  updatedAt: '2026-01-01T00:00:00Z',
  author: { username: 'ana' },
  project: { fullPath: 'g/p' },
  labels: { nodes: [] },
  ...extra,
});

function graphqlPage(nodes, hasNextPage = false) {
  return {
    data: {
      project: { mergeRequests: { pageInfo: { hasNextPage, endCursor: null }, nodes } },
      group: null,
    },
  };
}

function setup({ fetchImpl, query = '' } = {}) {
  run.clearCache();
  const { document, window } = parseHTML(html);
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'csrf-token');
  meta.setAttribute('content', 'tok');
  document.head.appendChild(meta);

  const sent = [];
  const deps = {
    doc: document,
    href: href + query,
    send: (payload) => sent.push(payload),
    configOverride: { hideDrafts: true, labels: ['dependencies'], hosts: [], pausedHosts: [] },
    fetchImpl: fetchImpl || (async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      text: async () => JSON.stringify(graphqlPage([
        node(470, { labels: { nodes: [{ title: 'dependencies' }] } }),
        node(999, { draft: true }),
        node(450),
      ])),
    })),
  };
  return { document, window, sent, deps };
}

test('hides MRs that are not on the page and corrects the Open count', async () => {
  const { document, sent, deps } = setup();
  await run.boot(deps);

  const panel = document.getElementById('gdh-panel');
  assert.match(panel.textContent, /!999 MR 999/);
  assert.equal(document.getElementById('gdh-tab').textContent, 'Hidden (5)');
  assert.match(document.querySelector('a[href*="state=opened"]').textContent, /35/);
  assert.equal(sent.at(-1).state, 'full');
  assert.equal(sent.at(-1).hiddenCount, 5);
});

test('sends the CSRF header and the query to the same origin', async () => {
  let seen = null;
  const { deps } = setup({
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return {
        ok: true, status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify(graphqlPage([node(999, { draft: true })])),
      };
    },
  });
  await run.boot(deps);
  assert.equal(seen.url, 'https://gitlab.com/api/graphql');
  assert.equal(seen.init.headers['X-CSRF-Token'], 'tok');
  assert.equal(seen.init.credentials, 'same-origin');
});

test('falls back to page-only when GitLab does not answer', async () => {
  const { document, sent, deps } = setup({
    fetchImpl: async () => ({ ok: false, status: 500, headers: new Map([['content-type', 'text/html']]), text: async () => '<html>' }),
  });
  await run.boot(deps);
  assert.match(document.getElementById('gdh-panel').textContent, /GitLab didn't answer/);
  assert.equal(sent.at(-1).state, 'page');
  assert.equal(sent.at(-1).reason, 'error');
  assert.match(document.querySelector('a[href*="state=opened"]').textContent, /37/);
});

test('does not adjust counts when the URL carries an unknown filter', async () => {
  const { document, sent, deps } = setup({ query: '&timeframe=month' });
  await run.boot(deps);
  assert.match(document.querySelector('a[href*="state=opened"]').textContent, /37/);
  assert.match(document.getElementById('gdh-panel').textContent, /not adjusted/);
  assert.equal(sent.at(-1).state, 'full');
});

test('reports signed out when the page has no CSRF token', async () => {
  const { document, sent, deps } = setup();
  document.querySelector('meta[name="csrf-token"]').remove();
  await run.boot(deps);
  assert.equal(sent.at(-1).state, 'page');
  assert.equal(sent.at(-1).reason, 'signed-out');
  assert.match(document.getElementById('gdh-panel').textContent, /Signed out/);
});
