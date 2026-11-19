import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { loadGlobal } from './helpers/load.js';

loadGlobal('classify.js', 'GDHClassify');
loadGlobal('hosts.js', 'GDHHosts');
loadGlobal('dom.js', 'GDHDom');
loadGlobal('reconcile.js', 'GDHReconcile');
const run = loadGlobal('../content/content.js', 'GDHRun');

const html = readFileSync(new URL('./fixtures/list.html', import.meta.url), 'utf8');
const href = 'https://gitlab.com/g/p/-/merge_requests?state=opened';

function setup(overrides = {}) {
  const { document, window } = parseHTML(html);
  const sent = [];
  const deps = {
    doc: document,
    href,
    send: (payload) => sent.push(payload),
    configOverride: { hideDrafts: true, labels: ['dependencies'], hosts: [], pausedHosts: [] },
    ...overrides,
  };
  return { document, window, sent, deps };
}

test('hides drafts and labelled rows on first paint and reports page-only', async () => {
  const { document, sent, deps } = setup();
  await run.boot(deps);
  const hidden = [...document.querySelectorAll('[data-gdh-hidden="1"]')].map((el) => el.textContent);
  assert.equal(hidden.length, 3); // 482 (label), 476 (WIP:), 461 (Draft badge)
  assert.ok(hidden.some((t) => t.includes('Fix flaky login spec')));
  assert.ok(!hidden.some((t) => t.includes('dependencies-java')));
  assert.ok(!hidden.some((t) => t.includes('Drafting the plan')));
  assert.equal(sent.at(-1).state, 'page');
  assert.equal(sent.at(-1).hiddenCount, 3);
});

test('mounts the Hidden tab and lists every hidden MR with a reason', async () => {
  const { document, window, deps } = setup();
  await run.boot(deps);
  const tab = document.getElementById('gdh-tab');
  assert.equal(tab.textContent, 'Hidden (3)');
  const panel = document.getElementById('gdh-panel');
  assert.equal(panel.querySelectorAll('.gdh-item').length, 3);
  assert.match(panel.textContent, /label: dependencies/);
  assert.match(panel.textContent, /Draft/);
  tab.dispatchEvent(new window.Event('click'));
  assert.equal(panel.hidden, false);
  assert.equal(tab.getAttribute('aria-selected'), 'true');
});

test('does nothing on merged and closed lists', async () => {
  const { document, sent, deps } = setup({ href: 'https://gitlab.com/g/p/-/merge_requests?state=merged' });
  await run.boot(deps);
  assert.equal(document.querySelectorAll('[data-gdh-hidden="1"]').length, 0);
  assert.equal(document.getElementById('gdh-tab'), null);
  assert.equal(sent.at(-1).state, 'idle');
});

test('respects a paused host', async () => {
  const { document, sent, deps } = setup();
  deps.configOverride = { ...deps.configOverride, pausedHosts: ['https://gitlab.com'] };
  await run.boot(deps);
  assert.equal(document.querySelectorAll('[data-gdh-hidden="1"]').length, 0);
  assert.equal(sent.at(-1).state, 'paused');
});

test('does not hide anything when the label list is empty and draft hiding is off', async () => {
  const { document, deps } = setup();
  deps.configOverride = { hideDrafts: false, labels: [], hosts: [], pausedHosts: [] };
  await run.boot(deps);
  assert.equal(document.querySelectorAll('[data-gdh-hidden="1"]').length, 0);
  assert.match(document.getElementById('gdh-panel').textContent, /Nothing hidden/);
});
