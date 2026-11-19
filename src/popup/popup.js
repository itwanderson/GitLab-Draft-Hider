// Popup: one sentence about this tab, and the actions that make sense here.
(function () {
  'use strict';

  var GDHHosts = globalThis.GDHHosts;
  var tab = null;
  var config = null;
  var base = null;

  function $(id) {
    return document.getElementById(id);
  }

  function send(message) {
    return chrome.runtime.sendMessage(message).then(function (reply) {
      if (!reply || reply.ok === false) throw new Error((reply && reply.error) || 'request failed');
      return reply;
    });
  }

  function hostKey() {
    return base ? base.origin + base.prefix : '';
  }

  function statusText(state) {
    if (state.state === 'full') return 'Full list — ' + state.hiddenCount + ' hidden';
    if (state.state === 'paused') return 'Paused on this GitLab';
    if (state.state === 'page') {
      return state.reason === 'error'
        ? "This page only — GitLab didn't answer"
        : 'This page only — signed out';
    }
    return 'Open a Merge requests list';
  }

  function render(state) {
    $('status').textContent = statusText(state);
    $('host').textContent = base ? base.origin + base.prefix : '';

    var onList = !!base && state.state !== 'idle';
    $('pause').hidden = !onList;
    $('pause').textContent = state.state === 'paused' ? 'Resume here' : 'Pause here';

    var known = config.hosts.some(function (host) { return host.url === hostKey(); }) || hostKey() === 'https://gitlab.com';
    $('enable').hidden = !base || known;
  }

  async function isGitLabPage() {
    if (!tab || !tab.id) return false;
    try {
      var results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function () { return !!document.querySelector('meta[name="csrf-token"]'); },
      });
      return !!(results && results[0] && results[0].result);
    } catch (e) {
      return false;
    }
  }

  async function load() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0] ? tabs[0] : null;
    var reply = await send({ type: 'gdh:get-config' });
    config = reply.config;

    if (tab && tab.url) base = GDHHosts.resolveBase(tab.url, config.hosts);
    var stateReply = await send({ type: 'gdh:tab-state', tabId: tab ? tab.id : -1 });

    if (base && !config.hosts.some(function (host) { return host.url === hostKey(); }) && hostKey() !== 'https://gitlab.com') {
      if (!(await isGitLabPage())) base = null;
    }
    render(stateReply.tab || { state: 'idle' });
  }

  function fail(error) {
    $('status').textContent = String(error && error.message ? error.message : error);
  }

  $('pause').addEventListener('click', function () {
    var paused = $('pause').textContent === 'Resume here';
    var key = hostKey();
    send({ type: 'gdh:set-paused', hostKey: key, paused: !paused }).then(function (reply) {
      config = reply.config;
      return send({ type: 'gdh:tab-state', tabId: tab.id });
    }).then(function (reply) {
      render(reply.tab || { state: 'idle' });
    }, fail);
  });

  $('enable').addEventListener('click', function () {
    if (!base) return;
    var origins = [GDHHosts.matchPattern(base)];
    chrome.permissions.request({ origins: origins }).then(function (granted) {
      if (!granted) {
        fail(new Error('Permission denied — this GitLab was not added.'));
        return;
      }
      return send({ type: 'gdh:add-host', url: base.origin + base.prefix }).then(function (reply) {
        config = reply.config;
        render({ state: 'idle' });
      });
    }).catch(fail);
  });

  $('settings').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  load().catch(fail);
})();
