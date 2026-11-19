import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseHTML } from 'linkedom';

const html = readFileSync(new URL('../src/popup/popup.html', import.meta.url), 'utf8');
const { document } = parseHTML(html);

test('has a status line and the three actions', () => {
  for (const id of ['status', 'pause', 'enable', 'settings']) {
    assert.ok(document.getElementById(id), id);
  }
});

test('loads its library and script, with no inline handlers', () => {
  const srcs = [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
  assert.deepEqual(srcs, ['../lib/hosts.js', 'popup.js']);
  for (const s of srcs) assert.ok(existsSync(new URL(`../src/popup/${s}`, import.meta.url)), s);
  assert.equal(html.includes('onclick='), false);
});
