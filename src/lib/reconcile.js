// Merges the two data sources into one decision about what is hidden.
// Identity is (project full path, iid): in a group list the same iid exists in
// several projects, so iid alone would hide the wrong row.
(function (root) {
  'use strict';

  var GDHClassify = root.GDHClassify;

  function keyOf(entry) {
    return entry.path + '!' + entry.iid;
  }

  function pass(items, config, webUrlOf) {
    var hide = new Set();
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var decision = GDHClassify.classify(
        { draft: !!item.draft, labels: item.labels || [] },
        { hideDrafts: config.hideDrafts, labels: config.labels || [] }
      );
      if (!decision.hidden) continue;
      var key = keyOf(item);
      if (hide.has(key)) continue;
      hide.add(key);
      out.push({
        path: item.path,
        iid: item.iid,
        title: item.title,
        webUrl: webUrlOf(item),
        reasons: decision.reasons,
      });
    }
    return { hide: hide, items: out };
  }

  function pagePass(rows, config) {
    return pass(rows || [], config, function (row) {
      return row.webUrl || row.href || '';
    });
  }

  function sessionPass(entries, config) {
    return pass(entries || [], config, function (entry) {
      return entry.webUrl || '';
    });
  }

  function merge(page, session, options) {
    var unknown = (options && options.unknownFilters) || [];
    var hide = new Set(page.hide);
    session.hide.forEach(function (key) {
      hide.add(key);
    });
    // The session answer wins on spelling and reasons, but a page-only hidden MR
    // must still appear in the tab: nothing hidden may go unlisted.
    var items = [];
    var seen = new Set();
    var ordered = session.items.concat(page.items);
    for (var i = 0; i < ordered.length; i++) {
      var key = keyOf(ordered[i]);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(ordered[i]);
    }
    return {
      hide: hide,
      items: items,
      countDelta: unknown.length ? 0 : session.items.length,
    };
  }

  root.GDHReconcile = {
    keyOf: keyOf,
    pagePass: pagePass,
    sessionPass: sessionPass,
    merge: merge,
  };
})(globalThis);
