// Content script: turns GitLab's merge request list into "ready work".
// First paint hides from the page's own rows; the session query (Task 11) then
// replaces that with the complete answer when it is available.
// Dependencies are injectable so the wiring can be tested without a browser.
(function (root) {
  'use strict';

  var GDHHosts = root.GDHHosts;
  var GDHDom = root.GDHDom;
  var GDHReconcile = root.GDHReconcile;

  var BOOT_DELAY = 150;
  var generation = 0;
  var lastHref = null;
  var observer = null;
  var timer = null;

  var ui = { doc: null, rows: null, panel: null, tab: null, count: null, base: null, parsed: null, config: null };
  var lastHide = new Set();
  var lastItems = [];

  function defaultConfig() {
    return { hideDrafts: true, labels: [], hosts: [], pausedHosts: [] };
  }

  function getConfig() {
    try {
      return chrome.runtime.sendMessage({ type: 'gdh:get-config' })
        .then(function (reply) { return (reply && reply.config) || defaultConfig(); })
        .catch(defaultConfig);
    } catch (e) {
      return Promise.resolve(defaultConfig());
    }
  }

  function send(payload) {
    try {
      var pending = chrome.runtime.sendMessage(payload);
      if (pending && typeof pending.catch === 'function') pending.catch(function () {});
    } catch (e) {
      /* the worker is asleep or the extension is reloading */
    }
  }

  function report(deps, state, hiddenCount, reason) {
    deps.send({ type: 'gdh:status', state: state, hiddenCount: hiddenCount || 0, reason: reason });
  }

  function applyMarks(hide) {
    if (!ui.rows) return;
    var rows = ui.rows.read();
    for (var i = 0; i < rows.length; i++) {
      ui.rows.hide(rows[i].path + '!' + rows[i].iid, hide.has(rows[i].path + '!' + rows[i].iid));
    }
  }

  function cleanup() {
    if (ui.tab) ui.tab.unmount();
    if (ui.panel && ui.panel.node && ui.panel.node.parentElement) {
      ui.panel.node.parentElement.removeChild(ui.panel.node);
    }
    if (ui.count) ui.count.reset();
    if (ui.rows) {
      var rows = ui.rows.read();
      for (var i = 0; i < rows.length; i++) rows[i].el.removeAttribute('data-gdh-hidden');
    }
    ui = { doc: null, rows: null, panel: null, tab: null, count: null, base: null, parsed: null, config: null };
    lastHide = new Set();
    lastItems = [];
  }

  function mount(deps, cfg, base, parsed) {
    var doc = deps.doc;
    ui.doc = doc;
    ui.config = cfg;
    ui.base = base;
    ui.parsed = parsed;
    ui.rows = GDHDom.createRows(doc, base);
    ui.panel = GDHDom.createPanel(doc);
    ui.count = GDHDom.createOpenCount(doc);
    ui.tab = GDHDom.mountTab(doc, GDHDom.tabBar(doc), {
      count: 0,
      onSelect: function () { ui.panel.show(); },
      onUnselect: function () { ui.panel.hide(); },
    });
  }

  function showPagePass(page) {
    lastHide = page.hide;
    lastItems = page.items;
    applyMarks(lastHide);
    if (ui.panel) ui.panel.setItems(lastItems);
    if (ui.tab) ui.tab.setCount(lastItems.length);
  }

  function baseEnvironment() {
    return {
      doc: typeof document !== 'undefined' ? document : null,
      href: typeof location !== 'undefined' ? location.href : '',
      send: send,
      config: getConfig,
    };
  }

  async function boot(overrides) {
    var deps = Object.assign(baseEnvironment(), overrides || {});
    var gen = ++generation;
    var cfg = deps.configOverride || (await deps.config());
    if (gen !== generation) return;

    var href = deps.href;
    lastHref = href;
    var base = GDHHosts.resolveBase(href, cfg.hosts);
    if (!base || !GDHHosts.isMergeRequestListUrl(href, base)) {
      cleanup();
      report(deps, 'idle');
      return;
    }
    var parsed = GDHHosts.parseListUrl(href, base);
    if (!parsed || (parsed.state !== null && parsed.state !== 'opened' && parsed.state !== 'all')) {
      cleanup();
      report(deps, 'idle');
      return;
    }
    var hostKey = base.origin + base.prefix;
    if ((cfg.pausedHosts || []).indexOf(hostKey) !== -1) {
      cleanup();
      report(deps, 'paused');
      return;
    }

    cleanup();
    mount(deps, cfg, base, parsed);
    var page = GDHReconcile.pagePass(ui.rows.read(), cfg);
    showPagePass(page);
    report(deps, 'page', lastItems.length);
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      if (typeof location === 'undefined') return;
      if (location.href !== lastHref) {
        boot();
        return;
      }
      applyMarks(lastHide);
      if (ui.panel && !document.getElementById('gdh-panel')) boot();
    }, BOOT_DELAY);
  }

  function start() {
    root.GDHRun = { boot: boot, get lastItems() { return lastItems; } };
    boot();
    if (!observer && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener('popstate', schedule);
    window.addEventListener('pagehide', function () { send({ type: 'gdh:status', state: 'idle', hiddenCount: 0 }); });
  }

  root.GDHRun = { boot: boot, get lastItems() { return lastItems; } };

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
})(globalThis);
