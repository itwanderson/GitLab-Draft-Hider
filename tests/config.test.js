import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load.js';

loadGlobal('hosts.js', 'GDHHosts');
const { createConfig } = loadGlobal('config.js', 'GDHConfig');

function memoryArea() {
  let box = {};
  return {
    get: async () => ({ ...box }),
    set: async (o) => { box = { ...box, ...o }; },
    dump: () => box,
  };
}

test('starts from defaults and persists a patch', async () => {
  const area = memoryArea();
  const c = createConfig(area);
  assert.equal((await c.read()).hideDrafts, true);
  await c.patch({ hideDrafts: false });
  assert.equal((await createConfig(area).read()).hideDrafts, false);
});

test('dedupes labels case-insensitively, keeping the first spelling', async () => {
  const c = createConfig(memoryArea());
  await c.addLabel('Dependencies');
  await c.addLabel('dependencies');
  await c.addLabel('  ');
  assert.deepEqual((await c.read()).labels, ['Dependencies']);
});

test('adds hosts once, by registration id', async () => {
  const c = createConfig(memoryArea());
  await c.addHost('https://example.com/gitlab/');
  await c.addHost('https://example.com/gitlab');
  const { hosts } = await c.read();
  assert.deepEqual(hosts, [{ url: 'https://example.com/gitlab', id: 'gdh-https-example-com-gitlab' }]);
});

test('exports only labels and toggles, and re-imports them', async () => {
  const c = createConfig(memoryArea());
  await c.addLabel('on-hold');
  await c.addHost('https://example.com');
  await c.setPaused('https://example.com', true);
  const json = await c.exportJson();
  assert.deepEqual(JSON.parse(json), { version: 1, hideDrafts: true, labels: ['on-hold'] });
  const other = createConfig(memoryArea());
  await other.importJson(json);
  assert.deepEqual((await other.read()).labels, ['on-hold']);
  await assert.rejects(() => other.importJson('{"version":9}'), /invalid config/);
});
