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
    var config = GDHConfig.createConfig(deps.area);
    var tabStates = new Map();

    function paint(tabId, state, hiddenCount, reason) {
      var info = GDHIcons.stateFor({ state: state, hiddenCount: hiddenCount, reason: reason });
      var options = { tabId: tabId };
      action.setIcon({ tabId: tabId, path: GDHIcons.pathsFor(info.state) });
      action.setBadgeText({ tabId: tabId, text: info.badge });
      if (info.badge) {
        action.setBadgeBackgroundColor({ tabId: tabId, color: BADGE_COLOR[info.state] || '#6b7280' });
      }
      action.setTitle({ tabId: tabId, title: info.title });
      return options;
    }

    async function status(msg, sender) {
      var tabId = sender && sender.tab ? sender.tab.id : undefined;
      if (tabId === undefined) return { ok: false, error: 'no-tab' };
      tabStates.set(tabId, { state: msg.state, hiddenCount: msg.hiddenCount || 0, reason: msg.reason });
      paint(tabId, msg.state, msg.hiddenCount, msg.reason);
      return { ok: true };
    }

    async function addHost(url) {
      var base = GDHHosts.normalizeBaseUrl(url);
      if (!base) return { ok: false, error: 'invalid' };
      var registration = GDHHosts.registrationFor(base);
      var current = await config.read();
      var already = current.hosts.some(function (host) {
        return host.id === registration.id;
      });
      if (already) return { ok: true, config: current };
      try {
        await scripting.registerContentScripts([{
          id: registration.id,
          matches: registration.matches,
          js: registration.js,
          css: registration.css,
          runAt: registration.runAt,
          persistAcrossSessions: true,
        }]);
      } catch (e) {
        return { ok: false, error: 'registration-failed' };
      }
      var next = await config.addHost(url);
      // Best effort: inject into tabs that are already open on that GitLab.
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

    async function onMessage(msg, sender) {
      if (!sender || sender.id !== runtime.id) return { ok: false, error: 'forbidden' };
      var type = msg && msg.type;
      if (type === 'gdh:status') return status(msg, sender);
      if (type === 'gdh:get-config') return { ok: true, config: await config.read() };
      if (type === 'gdh:set-config') return { ok: true, config: await config.patch(msg.patch || {}) };
      if (type === 'gdh:add-label') return { ok: true, config: await config.addLabel(msg.name) };
      if (type === 'gdh:remove-label') return { ok: true, config: await config.removeLabel(msg.name) };
      if (type === 'gdh:set-paused') return { ok: true, config: await config.setPaused(msg.hostKey, !!msg.paused) };
      if (type === 'gdh:add-host') return addHost(msg.url);
      if (type === 'gdh:forget-host') return { ok: true, config: await config.removeHost(msg.id) };
      if (type === 'gdh:tab-state') {
        return { ok: true, tab: tabStates.get(msg.tabId) || { state: 'idle', hiddenCount: 0 } };
      }
      if (type === 'gdh:export-config') return { ok: true, json: await config.exportJson() };
      if (type === 'gdh:import-config') {
        try {
          return { ok: true, config: await config.importJson(msg.json) };
        } catch (e) {
          return { ok: false, error: 'invalid' };
        }
      }
      return { ok: false, error: 'unknown-message' };
    }

    async function onUpdated(tabId, changeInfo) {
      if (!changeInfo || changeInfo.status !== 'loading') return;
      tabStates.delete(tabId);
      paint(tabId, 'idle', 0);
    }

    async function onRemoved(removed) {
      var current = await config.read();
      var origins = (removed && removed.origins) || [];
      var ids = [];
      for (var i = 0; i < origins.length; i++) {
        for (var j = 0; j < current.hosts.length; j++) {
          var base = GDHHosts.normalizeBaseUrl(current.hosts[j].url);
          if (base && GDHHosts.matchPattern(base) === origins[i]) {
            ids.push(current.hosts[j].id);
          }
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
      return { ok: true, config: next };
    }

    return { onMessage: onMessage, onUpdated: onUpdated, onRemoved: onRemoved };
  }

  root.GDHServiceWorker = { createHandlers: createHandlers };
})(globalThis);
