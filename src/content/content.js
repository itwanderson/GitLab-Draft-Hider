// Content script: turns GitLab's merge request list into "ready work".
// First paint hides from the page's own rows; the session query (Task 11) then
// replaces that with the complete answer when it is available.
// Dependencies are injectable so the wiring can be tested without a browser.
(function (root) {
  'use strict';

  var GDHHosts = root.GDHHosts;
  var GDHDom = root.GDHDom;
  var GDHReconcile = root.GDHReconcile;
  var GDHGraphql = root.GDHGraphql;

  var BOOT_DELAY = 150;
  var CACHE_MS = 60000;
  var cache = new Map();
  var myUsername = null;
  var generation = 0;
  var lastHref = null;
  var observer = null;
  var timer = null;

  var ui = { doc: null, rows: null, panel: null, tab: null, count: null, base: null, parsed: null, config: null, countDelta: 0 };
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
    ui = { doc: null, rows: null, panel: null, tab: null, count: null, base: null, parsed: null, config: null, countDelta: 0 };
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

  function applyCount() {
    if (!ui.count) return;
    if (ui.countDelta) ui.count.adjust(ui.countDelta);
    else ui.count.reset();
  }

  function showPagePass(page) {
    lastHide = page.hide;
    lastItems = page.items;
    applyMarks(lastHide);
    if (ui.panel) ui.panel.setItems(lastItems);
    if (ui.tab) ui.tab.setCount(lastItems.length);
  }

  async function fetchHidden(deps, base, parsed, cfg) {
    var meta = deps.doc.querySelector('meta[name="csrf-token"]');
    var token = meta && meta.getAttribute('content');
    if (!token) return { ok: false, reason: 'signed-out' };

    var key = base.origin + base.prefix + '|' + parsed.path + '|' + JSON.stringify(parsed.filters || {});
    var hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

    var fetchImpl = deps.fetchImpl || function (url, init) { return fetch(url, init); };
    var client = GDHGraphql.createClient({
      fetchImpl: fetchImpl,
      endpoint: GDHHosts.graphqlUrl(base),
      csrfToken: token,
      maxPages: 10,
    });

    var value;
    try {
      if (parsed.filters && parsed.filters.scope && !myUsername) myUsername = await client.fetchUsername();
      var result = await client.fetchAll({
        path: parsed.path,
        filters: parsed.filters || {},
        me: myUsername,
      });
      value = result.scope
        ? { ok: true, entries: result.entries, truncated: result.truncated }
        : { ok: false, reason: 'signed-out' };
      if (value.ok) cache.set(key, { at: Date.now(), value: value });
    } catch (e) {
      value = { ok: false, reason: e && e.kind === 'signed-out' ? 'signed-out' : 'error' };
    }
    return value;
  }

  function renderFull(deps, page, session, parsed, cfg) {
    var merged = GDHReconcile.merge(
      page,
      GDHReconcile.sessionPass(session.entries, cfg),
      { unknownFilters: parsed.unknownFilters }
    );
    lastHide = merged.hide;
    lastItems = merged.items;
    applyMarks(lastHide);
    if (ui.panel) ui.panel.setItems(lastItems);
    if (ui.tab) ui.tab.setCount(lastItems.length);

    var adjusts = parsed.state === null || parsed.state === 'opened';
    ui.countDelta = adjusts ? merged.countDelta : 0;
    applyCount();
    if (ui.panel) {
      var notes = [];
      if (session.truncated) notes.push('Showing the first 1,000 merge requests.');
      if (parsed.unknownFilters.length) notes.push('Hidden counts are not adjusted for the filters in this URL.');
      ui.panel.setStatus(notes.join(' ') || null, function () { boot(); });
    }
    report(deps, 'full', lastItems.length);
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

    var session = await fetchHidden(deps, base, parsed, cfg);
    if (gen !== generation) return;
    if (session.ok) {
      renderFull(deps, page, session, parsed, cfg);
    } else {
      ui.countDelta = 0;
      if (ui.panel) {
        ui.panel.setStatus(session.reason === 'signed-out'
          ? 'Signed out — showing the MRs on this page only.'
          : "GitLab didn't answer — showing the MRs on this page only.", function () { boot(); });
      }
      if (ui.count) ui.count.reset();
      report(deps, 'page', lastItems.length, session.reason === 'signed-out' ? 'signed-out' : 'error');
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(function () {
      timer = null;
      if (typeof location === 'undefined') return;
      if (location.href !== lastHref) {
        boot().catch(function () {});
        return;
      }
      applyMarks(lastHide);
      applyCount();
      if (ui.panel && !document.getElementById('gdh-panel')) boot();
    }, BOOT_DELAY);
  }

  function start() {
    boot().catch(function () { report(baseEnvironment(), 'idle'); });
    if (!observer && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener('popstate', schedule);
    window.addEventListener('pagehide', function () {
      send({ type: 'gdh:status', state: 'idle', hiddenCount: 0 });
    });
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (message) {
        if (message && message.type === 'gdh:refresh') boot().catch(function () {});
      });
    }
  }

  function reapply() {
    applyMarks(lastHide);
    applyCount();
  }

  root.GDHRun = {
    boot: boot,
    reapply: reapply,
    clearCache: function () { cache.clear(); myUsername = null; },
    get lastItems() { return lastItems; },
  };

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
})(globalThis);
