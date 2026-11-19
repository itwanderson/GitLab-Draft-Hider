// Popup: one sentence about this tab, and the actions that make sense here.
(function () {
  'use strict';

  var GDHHosts = globalThis.GDHHosts;
  var GDHPopup = globalThis.GDHPopup;

  var tab = null;
  var config = null;
  var view = null;

  function $(id) {
    return document.getElementById(id);
  }

  function send(message) {
    return chrome.runtime.sendMessage(message).then(function (reply) {
      if (!reply || reply.ok === false) throw new Error((reply && reply.error) || 'request failed');
      return reply;
    });
  }

  async function looksLikeGitLab(tabId, hostKey, enabled) {
    if (!tabId || enabled || hostKey === 'https://gitlab.com') return enabled || hostKey === 'https://gitlab.com';
    try {
      var results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function () { return !!document.querySelector('meta[name="csrf-token"]'); },
      });
      return !!(results && results[0] && results[0].result);
    } catch (e) {
      return false;
    }
  }

  function render(next) {
    view = next;
    $('status').textContent = view.status;
    $('host').textContent = view.host;
    $('pause').hidden = !view.showPause;
    $('pause').textContent = view.pauseLabel;
    $('enable').hidden = !view.showEnable;
  }

  async function load() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0] ? tabs[0] : null;
    config = (await send({ type: 'gdh:get-config' })).config;
    var tabState = (await send({ type: 'gdh:tab-state', tabId: tab ? tab.id : -1 })).tab;
    var provisional = GDHPopup.model({ tabUrl: tab && tab.url, config: config, tabState: tabState, isGitLab: false });
    var enabled = provisional.hostKey === 'https://gitlab.com' ||
      (config.hosts || []).some(function (host) { return host.url === provisional.hostKey; });
    var isGitLab = await looksLikeGitLab(tab && tab.id, provisional.hostKey, enabled);
    render(GDHPopup.model({ tabUrl: tab && tab.url, config: config, tabState: tabState, isGitLab: isGitLab }));
  }

  function fail(error) {
    $('status').textContent = String(error && error.message ? error.message : error);
  }

  $('pause').addEventListener('click', function () {
    if (!view) return;
    var paused = view.pauseLabel === 'Resume here';
    send({ type: 'gdh:set-paused', hostKey: view.hostKey, paused: !paused })
      .then(load)
      .catch(fail);
  });

  $('enable').addEventListener('click', function () {
    if (!view || !view.enablePattern) return;
    chrome.permissions.request({ origins: [view.enablePattern] }).then(function (granted) {
      if (!granted) {
        fail(new Error('Permission denied — this GitLab was not added.'));
        return null;
      }
      return send({ type: 'gdh:add-host', url: view.hostKey }).then(load);
    }).catch(fail);
  });

  $('settings').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  load().catch(fail);
})();
