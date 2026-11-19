// Service worker logic, separated from the chrome.* wiring so it can be tested
// with fakes. The worker holds settings and the per-tab icon; it never holds a
// credential and never calls permissions.request (that needs a page's click).
(function (root) {
  'use strict';

  var GDHHosts = root.GDHHosts;
  var GDHConfig = root.GDHConfig;
  var GDHIcons = root.GDHIcons;

  var BADGE_COLOR = { full: '#6366f1', page: '#6b7280' };

  function createHandlers(deps) {
    var action = deps.action;
    var scripting = deps.scripting;
    var runtime = deps.runtime;
    var tabs = deps.tabs;
    var permissions = deps.permissions;
    var session = deps.session;
    var config = GDHConfig.createConfig(deps.area);

    function tabKey(tabId) {
      return 'gdh.tab.' + tabId;
    }

    async function rememberTab(tabId, state) {
      if (!session) return;
      try {
        var patch = {};
        patch[tabKey(tabId)] = state;
        await session.set(patch);
      } catch (e) {
        /* session storage is best effort */
      }
    }

    async function recallTab(tabId) {
      if (!session) return null;
      try {
        var stored = await session.get(tabKey(tabId));
        return (stored && stored[tabKey(tabId)]) || null;
      } catch (e) {
        return null;
      }
    }

    async function forgetTab(tabId) {
      if (!session) return;
      try {
        await session.remove(tabKey(tabId));
      } catch (e) {
        /* best effort */
      }
    }

    function paint(tabId, state, hiddenCount, reason) {
      var info = GDHIcons.stateFor({ state: state, hiddenCount: hiddenCount, reason: reason });
      action.setIcon({ tabId: tabId, path: GDHIcons.pathsFor(info.state) });
      action.setBadgeText({ tabId: tabId, text: info.badge });
      if (info.badge) {
        action.setBadgeBackgroundColor({ tabId: tabId, color: BADGE_COLOR[info.state] || '#6b7280' });
      }
      action.setTitle({ tabId: tabId, title: info.title });
    }

    async function refreshTabs() {
      try {
        var open = await tabs.query({});
        for (var i = 0; i < open.length; i++) {
          try {
            await tabs.sendMessage(open[i].id, { type: 'gdh:refresh' });
          } catch (e) {
            /* no content script in that tab */
          }
        }
      } catch (e) {
        /* tabs API unavailable */
      }
    }

    async function status(msg, sender) {
      var tabId = sender && sender.tab ? sender.tab.id : undefined;
      if (tabId === undefined) return { ok: false, error: 'no-tab' };
      var state = { state: msg.state, hiddenCount: msg.hiddenCount || 0, reason: msg.reason };
      await rememberTab(tabId, state);
      paint(tabId, msg.state, msg.hiddenCount, msg.reason);
      return { ok: true };
    }

    async function ensureRegistered(registration) {
      var existing = [];
      try {
        if (typeof scripting.getRegisteredContentScripts === 'function') {
          existing = await scripting.getRegisteredContentScripts({ ids: [registration.id] });
        }
      } catch (e) {
        existing = [];
      }
      if (existing && existing.length) return true;
      try {
        await scripting.registerContentScripts([{
          id: registration.id,
          matches: registration.matches,
          js: registration.js,
          css: registration.css,
          runAt: registration.runAt,
          persistAcrossSessions: true,
        }]);
        return true;
      } catch (e) {
        return false;
      }
    }

    async function addHost(url) {
      var base = GDHHosts.normalizeBaseUrl(url);
      if (!base) return { ok: false, error: 'invalid' };
      var current = await config.read();
      // gitlab.com is injected statically by the manifest. Registering it again
      // would run a second copy of the content script on every page.
      if (base.origin === 'https://gitlab.com' && !base.prefix) {
        return { ok: true, config: current };
      }
      var registration = GDHHosts.registrationFor(base);
      if (!(await ensureRegistered(registration))) return { ok: false, error: 'registration-failed' };

      var next = await config.addHost(url);
      try {
        if (tabs && typeof tabs.query === 'function') {
          var open = await tabs.query({ url: GDHHosts.matchPattern(base) });
          for (var i = 0; i < open.length; i++) {
            await scripting.executeScript({ target: { tabId: open[i].id }, files: registration.js });
          }
        }
      } catch (e) {
        /* the next navigation injects instead */
      }
      return { ok: true, config: next };
    }

    async function forgetHost(id) {
      var current = await config.read();
      var ids = [];
      for (var i = 0; i < current.hosts.length; i++) {
        if (current.hosts[i].id === id) ids.push(current.hosts[i].id);
      }
      if (ids.length) {
        try {
          await scripting.unregisterContentScripts({ ids: ids });
        } catch (e) {
          /* already gone */
        }
      }
      var next = await config.removeHost(id);
      await refreshTabs();
      return { ok: true, config: next };
    }

    async function onMessage(msg, sender) {
      if (!sender || sender.id !== runtime.id) return { ok: false, error: 'forbidden' };
      var type = msg && msg.type;
      if (type === 'gdh:status') return status(msg, sender);
      if (type === 'gdh:get-config') return { ok: true, config: await config.read() };
      if (type === 'gdh:set-config') {
        var patched = await config.patch(msg.patch || {});
        await refreshTabs();
        return { ok: true, config: patched };
      }
      if (type === 'gdh:add-label') {
        var added = await config.addLabel(msg.name);
        await refreshTabs();
        return { ok: true, config: added };
      }
      if (type === 'gdh:remove-label') {
        var removed = await config.removeLabel(msg.name);
        await refreshTabs();
        return { ok: true, config: removed };
      }
      if (type === 'gdh:set-paused') {
        var paused = await config.setPaused(msg.hostKey, !!msg.paused);
        await refreshTabs();
        return { ok: true, config: paused };
      }
      if (type === 'gdh:add-host') return addHost(msg.url);
      if (type === 'gdh:forget-host') return forgetHost(msg.id);
      if (type === 'gdh:tab-state') {
        var stored = await recallTab(msg.tabId);
        return { ok: true, tab: stored || { state: 'idle', hiddenCount: 0 } };
      }
      if (type === 'gdh:export-config') return { ok: true, json: await config.exportJson() };
      if (type === 'gdh:import-config') {
        try {
          var imported = await config.importJson(msg.json);
          await refreshTabs();
          return { ok: true, config: imported };
        } catch (e) {
          return { ok: false, error: 'invalid' };
        }
      }
      return { ok: false, error: 'unknown-message' };
    }

    async function onUpdated(tabId, changeInfo) {
      if (!changeInfo || changeInfo.status !== 'loading') return;
      await forgetTab(tabId);
      paint(tabId, 'idle', 0);
    }

    async function onRemoved(removed) {
      var current = await config.read();
      var origins = (removed && removed.origins) || [];
      var ids = [];
      for (var i = 0; i < origins.length; i++) {
        for (var j = 0; j < current.hosts.length; j++) {
          var base = GDHHosts.normalizeBaseUrl(current.hosts[j].url);
          if (base && GDHHosts.matchPattern(base) === origins[i]) ids.push(current.hosts[j].id);
        }
      }
      if (!ids.length) return { ok: false, error: 'unknown-host' };
      try {
        await scripting.unregisterContentScripts({ ids: ids });
      } catch (e) {
        /* already gone */
      }
      var next = current;
      for (var k = 0; k < ids.length; k++) next = await config.removeHost(ids[k]);
      await refreshTabs();
      return { ok: true, config: next };
    }

    return { onMessage: onMessage, onUpdated: onUpdated, onRemoved: onRemoved };
  }

  root.GDHServiceWorker = { createHandlers: createHandlers };
})(globalThis);
