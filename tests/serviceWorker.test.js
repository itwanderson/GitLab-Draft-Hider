import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load.js';

loadGlobal('hosts.js', 'GDHHosts');
loadGlobal('config.js', 'GDHConfig');
loadGlobal('iconState.js', 'GDHIcons');

const core = loadGlobal('../background/serviceWorkerCore.js', 'GDHServiceWorker');

const fakes = () => {
  const calls = { icon: [], badge: [], color: [], title: [], registered: [], unregistered: [], messages: [] };
  let box = {};
  const sessionBox = {};
  return {
    calls,
    area: { get: async () => ({ ...box }), set: async (o) => { box = { ...box, ...o }; } },
    session: {
      get: async (key) => ({ [key]: sessionBox[key] }),
      set: async (o) => { Object.assign(sessionBox, o); },
      remove: async (key) => { delete sessionBox[key]; },
    },
    action: {
      setIcon: (o) => calls.icon.push(o),
      setBadgeText: (o) => calls.badge.push(o),
      setBadgeBackgroundColor: (o) => calls.color.push(o),
      setTitle: (o) => calls.title.push(o),
    },
    tabs: {
      onUpdated: { addListener() {} },
      query: async () => [{ id: 11 }],
      sendMessage: async (id, msg) => { calls.messages.push({ id, msg }); },
    },
    permissions: { onRemoved: { addListener() {} } },
    scripting: {
      registerContentScripts: async (o) => calls.registered.push(o),
      unregisterContentScripts: async (o) => calls.unregistered.push(o),
      executeScript: async () => [],
    },
    runtime: { onMessage: { addListener() {} }, id: 'self' },
  };
};

test('status sets the icon for that tab only', async () => {
  const f = fakes();
  const h = core.createHandlers(f);
  await h.onMessage({ type: 'gdh:status', state: 'full', hiddenCount: 5, reason: 'signed-out' }, { tab: { id: 7 }, id: 'self' });
  assert.equal(f.calls.icon.at(-1).tabId, 7);
  assert.equal(f.calls.icon.at(-1).path['16'], 'icons/icon-16-full.png');
  assert.equal(f.calls.badge.at(-1).text, '5');
  assert.equal(f.calls.badge.at(-1).tabId, 7);
});

test('a page-only status carries the reason into the tooltip', async () => {
  const f = fakes();
  const h = core.createHandlers(f);
  await h.onMessage({ type: 'gdh:status', state: 'page', hiddenCount: 2, reason: 'error' }, { tab: { id: 3 }, id: 'self' });
  assert.equal(f.calls.icon.at(-1).path['16'], 'icons/icon-16-page.png');
  assert.match(f.calls.title.at(-1).title, /GitLab didn't answer/);
});

test('ignores messages from another extension', async () => {
  const f = fakes();
  const h = core.createHandlers(f);
  const r = await h.onMessage({ type: 'gdh:status' }, { tab: { id: 7 }, id: 'other' });
  assert.equal(r.ok, false);
  assert.equal(f.calls.icon.length, 0);
});

test('navigation start resets a tab to idle', async () => {
  const f = fakes();
  const h = core.createHandlers(f);
  await h.onUpdated(7, { status: 'loading' });
  assert.equal(f.calls.icon.at(-1).path['16'], 'icons/icon-16-idle.png');
  assert.equal(f.calls.badge.at(-1).text, '');
});

test('adding an already-granted host registers exactly that origin and path', async () => {
  const f = fakes();
  const h = core.createHandlers(f);
  const r = await h.onMessage({ type: 'gdh:add-host', url: 'https://example.com/gitlab' }, { id: 'self' });
  assert.equal(r.ok, true);
  assert.equal(f.calls.registered.at(-1)[0].id, 'gdh-https-example-com-gitlab');
  assert.deepEqual(f.calls.registered.at(-1)[0].matches, ['https://example.com/gitlab/*']);
  assert.equal(f.calls.registered.at(-1)[0].persistAcrossSessions, true);
  assert.deepEqual(r.config.hosts.map((x) => x.url), ['https://example.com/gitlab']);
});

test('adding garbage changes nothing', async () => {
  const f = fakes();
  const h = core.createHandlers(f);
  const r = await h.onMessage({ type: 'gdh:add-host', url: 'not a url' }, { id: 'self' });
  assert.deepEqual(r, { ok: false, error: 'invalid' });
  assert.equal(f.calls.registered.length, 0);
});

test('a revoked grant unregisters that host and forgets it', async () => {
  const f = fakes();
  const h = core.createHandlers(f);
  await h.onMessage({ type: 'gdh:add-host', url: 'https://example.com/gitlab' }, { id: 'self' });
  const r = await h.onRemoved({ origins: ['https://example.com/gitlab/*'] });
  assert.deepEqual(f.calls.unregistered.at(-1), { ids: ['gdh-https-example-com-gitlab'] });
  assert.deepEqual(r.config.hosts, []);
});

test('remembers the last state for a tab, and forgets it on navigation', async () => {
  const f = fakes();
  const h = core.createHandlers(f);
  let r = await h.onMessage({ type: 'gdh:tab-state', tabId: 7 }, { id: 'self' });
  assert.equal(r.tab.state, 'idle');
  await h.onMessage({ type: 'gdh:status', state: 'page', hiddenCount: 4, reason: 'error' }, { tab: { id: 7 }, id: 'self' });
  r = await h.onMessage({ type: 'gdh:tab-state', tabId: 7 }, { id: 'self' });
  assert.deepEqual(r.tab, { state: 'page', hiddenCount: 4, reason: 'error' });
  await h.onUpdated(7, { status: 'loading' });
  r = await h.onMessage({ type: 'gdh:tab-state', tabId: 7 }, { id: 'self' });
  assert.equal(r.tab.state, 'idle');
});

test('exports and imports config through messages', async () => {
  const f = fakes();
  const h = core.createHandlers(f);
  await h.onMessage({ type: 'gdh:add-label', name: 'on-hold' }, { id: 'self' });
  const exported = await h.onMessage({ type: 'gdh:export-config' }, { id: 'self' });
  assert.match(exported.json, /on-hold/);
  assert.deepEqual(await h.onMessage({ type: 'gdh:import-config', json: '{"version":9}' }, { id: 'self' }),
    { ok: false, error: 'invalid' });
});

test('pause and config round-trip through the worker', async () => {
  const f = fakes();
  const h = core.createHandlers(f);
  const paused = await h.onMessage({ type: 'gdh:set-paused', hostKey: 'https://gitlab.com', paused: true }, { id: 'self' });
  assert.deepEqual(paused.config.pausedHosts, ['https://gitlab.com']);
  const labels = await h.onMessage({ type: 'gdh:add-label', name: 'dependencies' }, { id: 'self' });
  assert.deepEqual(labels.config.labels, ['dependencies']);
});

test('tab state survives a service worker restart', async () => {
  const f = fakes();
  await core.createHandlers(f).onMessage(
    { type: 'gdh:status', state: 'full', hiddenCount: 5 }, { tab: { id: 7 }, id: 'self' });
  // A new handler set is what a restarted worker looks like: module state is gone.
  const restarted = core.createHandlers(f);
  const r = await restarted.onMessage({ type: 'gdh:tab-state', tabId: 7 }, { id: 'self' });
  assert.deepEqual(r.tab, { state: 'full', hiddenCount: 5, reason: undefined });
});

test('pausing broadcasts a refresh to open tabs', async () => {
  const f = fakes();
  const h = core.createHandlers(f);
  await h.onMessage({ type: 'gdh:set-paused', hostKey: 'https://gitlab.com', paused: true }, { id: 'self' });
  assert.deepEqual(f.calls.messages.at(-1), { id: 11, msg: { type: 'gdh:refresh' } });
});

test('forget-host unregisters the dynamic script, and re-adding works', async () => {
  const f = fakes();
  const h = core.createHandlers(f);
  await h.onMessage({ type: 'gdh:add-host', url: 'https://example.com/gitlab' }, { id: 'self' });
  const r = await h.onMessage({ type: 'gdh:forget-host', id: 'gdh-https-example-com-gitlab' }, { id: 'self' });
  assert.deepEqual(f.calls.unregistered.at(-1), { ids: ['gdh-https-example-com-gitlab'] });
  assert.deepEqual(r.config.hosts, []);
  const again = await h.onMessage({ type: 'gdh:add-host', url: 'https://example.com/gitlab' }, { id: 'self' });
  assert.equal(again.ok, true);
  assert.equal(f.calls.registered.at(-1)[0].id, 'gdh-https-example-com-gitlab');
});

test('gitlab.com is built in and never registered dynamically', async () => {
  const f = fakes();
  const h = core.createHandlers(f);
  const r = await h.onMessage({ type: 'gdh:add-host', url: 'https://gitlab.com' }, { id: 'self' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.hosts, []);
  assert.equal(f.calls.registered.length, 0);
});
