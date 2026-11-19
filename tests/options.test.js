import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseHTML } from 'linkedom';

const html = readFileSync(new URL('../src/options/options.html', import.meta.url), 'utf8');
const { document } = parseHTML(html);

test('has every control the settings page needs', () => {
  for (const id of ['hide-drafts', 'label-input', 'add-label', 'labels', 'host-url',
    'add-host', 'hosts', 'export', 'import-file', 'notice', 'pause', 'source', 'retry']) {
    assert.ok(document.getElementById(id), id);
  }
});

test('explains that there is no token', () => {
  assert.match(document.body.textContent, /no token and stores no secret/);
});

test('loads its libraries and has no inline handlers', () => {
  const srcs = [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
  assert.deepEqual(srcs, ['../lib/hosts.js', 'options.js']);
  for (const s of srcs) assert.ok(existsSync(new URL(`../src/options/${s}`, import.meta.url)), s);
  assert.equal(html.includes('onclick='), false);
});

test('labels every input', () => {
  for (const input of document.querySelectorAll('input')) {
    const id = input.getAttribute('id');
    const labelled = document.querySelector(`label[for="${id}"]`) || input.closest('label') || input.getAttribute('aria-label');
    assert.ok(labelled, id);
  }
});
