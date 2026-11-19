import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('asks for the narrowest permissions', () => {
  assert.deepEqual([...m.permissions].sort(), ['activeTab', 'scripting', 'storage']);
  assert.equal(m.host_permissions, undefined);
  assert.ok(!JSON.stringify(m).includes('<all_urls>'));
  assert.deepEqual([...m.optional_host_permissions].sort(), ['http://*/*', 'https://*/*']);
});

test('injects statically only on gitlab.com', () => {
  assert.deepEqual(m.content_scripts.map((c) => c.matches), [['https://gitlab.com/*']]);
});

test('every referenced file exists, in load order', () => {
  const paths = [
    m.background.service_worker,
    m.options_ui.page,
    m.action.default_popup,
    ...m.content_scripts[0].js,
    ...m.content_scripts[0].css,
  ];
  for (const p of paths) assert.ok(existsSync(new URL(`../${p}`, import.meta.url)), p);
  const js = m.content_scripts[0].js;
  assert.ok(js.indexOf('src/lib/classify.js') < js.indexOf('src/lib/reconcile.js'));
  assert.equal(js.at(-1), 'src/content/content.js');
});
