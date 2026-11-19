import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { loadGlobal } from './helpers/load.js';

loadGlobal('classify.js', 'GDHClassify');
loadGlobal('hosts.js', 'GDHHosts');
const D = loadGlobal('dom.js', 'GDHDom');

const base = { origin: 'https://gitlab.com', prefix: '' };
const html = readFileSync(new URL('./fixtures/list.html', import.meta.url), 'utf8');

const setup = () => {
  const { document } = parseHTML(html);
  return { doc: document, rows: D.createRows(document, base) };
};

test('reads one row per iid with identity and signals', () => {
  const { rows } = setup();
  const all = rows.read();
  assert.equal(new Set(all.map((r) => `${r.path}!${r.iid}`)).size, all.length);
  const byKey = Object.fromEntries(all.map((r) => [`${r.path}!${r.iid}`, r]));
  assert.equal(byKey['g/p!482'].draft, false);
  assert.deepEqual(byKey['g/p!482'].labels, ['dependencies']);
  assert.deepEqual(byKey['g/p!470'].labels, ['dependencies-java']);
  assert.equal(byKey['g/p!476'].draft, true);
  assert.equal(byKey['g/p!461'].draft, true); // badge only
  assert.equal(byKey['g/p!450'].draft, false); // "Drafting the plan"
});

test('hides and unhides without removing nodes', () => {
  const { rows } = setup();
  const before = rows.read().length;
  rows.hide('g/p!482', true);
  assert.equal(rows.read().filter((r) => r.el.getAttribute('data-gdh-hidden') === '1').length, 1);
  assert.equal(rows.read().length, before);
  rows.hide('g/p!482', false);
  assert.equal(rows.read().filter((r) => r.el.getAttribute('data-gdh-hidden') === '1').length, 0);
});

test('adjusts the Open count from the original value and never goes negative', () => {
  const { doc } = setup();
  const count = D.createOpenCount(doc);
  count.adjust(5);
  assert.match(doc.querySelector('a[href*="state=opened"]').textContent, /32/);
  count.adjust(100);
  assert.match(doc.querySelector('a[href*="state=opened"]').textContent, /0/);
  count.reset();
  assert.match(doc.querySelector('a[href*="state=opened"]').textContent, /37/);
});

test('mounts an accessible tab and a panel after the list', () => {
  const { doc } = setup();
  const panel = D.createPanel(doc);
  const t = D.mountTab(doc, D.tabBar(doc), { count: 3, onSelect() {}, onUnselect() {} });
  assert.equal(t.button.getAttribute('role'), 'tab');
  assert.equal(t.button.getAttribute('aria-selected'), 'false');
  assert.equal(t.button.textContent, 'Hidden (3)');
  t.setActive(true);
  assert.equal(t.button.getAttribute('aria-selected'), 'true');
  assert.equal(panel.node.getAttribute('role'), 'tabpanel');
  assert.equal(panel.isShown(), false);
});

test('renders hidden items with their reasons and an empty state', () => {
  const { doc } = setup();
  const panel = D.createPanel(doc);
  panel.setItems([{ path: 'g/p', iid: 476, title: 'WIP: Rework billing', webUrl: 'https://gitlab.com/g/p/-/merge_requests/476', reasons: ['draft'] }]);
  const link = panel.node.querySelector('a');
  assert.equal(link.getAttribute('href'), 'https://gitlab.com/g/p/-/merge_requests/476');
  assert.match(link.textContent, /!476/);
  assert.match(panel.node.textContent, /Draft/);
  panel.setItems([]);
  assert.match(panel.node.textContent, /Nothing hidden/);
});
