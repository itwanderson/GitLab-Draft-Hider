// DOM adapter: finds GitLab's list rows, hides them, and adds our tab and panel.
// Tolerant by design — it keys off merge request URLs, not GitLab's CSS classes,
// and gives up quietly rather than breaking the page.
(function (root) {
  'use strict';

  var GDHHosts = root.GDHHosts;
  var GDHClassify = root.GDHClassify;
  var ANCHOR_SELECTOR = 'a[href*="/-/merge_requests/"]';
  var LABEL_SELECTOR = '[data-testid*="label"], .gl-label, .issuable-label';
  var BADGE_SELECTOR = '[data-testid*="badge"], .gl-badge, .badge';
  var LIST_SELECTOR = '[data-testid="issuable-list"], ul.merge-requests';
  var REASONS = { draft: 'Draft' };

  function absolute(href, base) {
    if (!href) return null;
    try {
      return new URL(href, base.origin + (base.prefix || '/')).href;
    } catch (e) {
      return null;
    }
  }

  function climb(anchor) {
    var node = anchor;
    for (var depth = 0; node && depth < 8; depth++) {
      if (node.tagName === 'LI') return node;
      if (node.getAttribute && node.getAttribute('role') === 'listitem') return node;
      node = node.parentElement;
    }
    return null;
  }

  function textOf(node) {
    return node && node.textContent ? node.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  function titleOf(row, anchor) {
    var own = textOf(anchor);
    if (own) return own;
    var title = row.querySelector('[data-testid*="title"], .merge-request-title-text, .title');
    return textOf(title);
  }

  function labelsOf(row) {
    var nodes = row.querySelectorAll(LABEL_SELECTOR);
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var text = textOf(nodes[i]);
      if (!text || text.charAt(0) === '+') continue;
      if (out.indexOf(text) === -1) out.push(text);
    }
    return out;
  }

  function hasDraftBadge(row) {
    var nodes = row.querySelectorAll(BADGE_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      if (textOf(nodes[i]) === 'Draft') return true;
    }
    return false;
  }

  function createRows(doc, base) {
    function read() {
      var anchors = doc.querySelectorAll(ANCHOR_SELECTOR);
      var seen = new Map();
      var out = [];
      for (var i = 0; i < anchors.length; i++) {
        var anchor = anchors[i];
        var href = absolute(anchor.getAttribute('href'), base);
        var id = href ? GDHHosts.identityFromHref(href, base) : null;
        var row = id ? climb(anchor) : null;
        if (!id || !row) continue;
        var key = id.path + '!' + id.iid;
        if (seen.has(key)) continue;
        var title = titleOf(row, anchor);
        seen.set(key, true);
        out.push({
          el: row,
          path: id.path,
          iid: id.iid,
          href: href,
          title: title,
          draft: GDHClassify.isDraftTitle(title) || hasDraftBadge(row),
          labels: labelsOf(row),
        });
      }
      return out;
    }

    function hide(key, on) {
      var rows = read();
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].path + '!' + rows[i].iid !== key) continue;
        if (on) rows[i].el.setAttribute('data-gdh-hidden', '1');
        else rows[i].el.removeAttribute('data-gdh-hidden');
      }
    }

    return { read: read, hide: hide };
  }

  function digitsNode(node) {
    if (!node) return null;
    if (node.nodeType === 3) return /\d/.test(node.nodeValue || '') ? node : null;
    var children = node.childNodes || [];
    for (var i = 0; i < children.length; i++) {
      var found = digitsNode(children[i]);
      if (found) return found;
    }
    return null;
  }

  function createOpenCount(doc) {
    function current() {
      var el = doc.querySelector('a[href*="state=opened"]');
      if (!el) return null;
      var node = digitsNode(el);
      return node ? { el: el, node: node } : null;
    }

    function baseFor(found) {
      if (!found.el.hasAttribute('data-gdh-base-count')) {
        var match = (found.node.nodeValue || '').match(/\d+/);
        found.el.setAttribute('data-gdh-base-count', match ? match[0] : '0');
      }
      return Number(found.el.getAttribute('data-gdh-base-count'));
    }

    // Resolved on every call: GitLab re-renders its tab bar, and a snapshot taken
    // at mount would either hit nothing or hold a stale node forever.
    function render(delta) {
      var found = current();
      if (!found) return;
      var base = baseFor(found);
      found.node.nodeValue = found.node.nodeValue.replace(/\d+/, String(Math.max(0, base - delta)));
    }

    return {
      adjust: function (delta) {
        render(Math.max(0, Number(delta) || 0));
      },
      reset: function () {
        render(0);
      },
      base: function () {
        var found = current();
        return found ? baseFor(found) : null;
      },
    };
  }

  function reasonText(reasons) {
    var out = [];
    for (var i = 0; i < (reasons || []).length; i++) {
      var reason = reasons[i];
      if (REASONS[reason]) out.push(REASONS[reason]);
      else if (reason.indexOf('label:') === 0) out.push('label: ' + reason.slice(6));
      else out.push(reason);
    }
    return out.join(' · ');
  }

  function createPanel(doc) {
    var existing = doc.getElementById('gdh-panel');
    if (existing) existing.remove();

    var node = doc.createElement('div');
    node.id = 'gdh-panel';
    node.setAttribute('role', 'tabpanel');
    node.setAttribute('aria-label', 'Hidden merge requests');
    node.hidden = true;

    var status = doc.createElement('div');
    status.className = 'gdh-status';
    status.hidden = true;

    var list = doc.createElement('div');
    list.className = 'gdh-items';

    node.appendChild(status);
    node.appendChild(list);

    var anchor = doc.querySelector(LIST_SELECTOR) || doc.querySelector('#list');
    var container = (anchor && (anchor.closest('section, div, main') || anchor.parentElement)) || doc.body;
    container.appendChild(node);

    function setItems(items) {
      while (list.firstChild) list.removeChild(list.firstChild);
      if (!items || !items.length) {
        var empty = doc.createElement('p');
        empty.className = 'gdh-empty';
        empty.textContent = 'Nothing hidden — the queue is all ready work.';
        list.appendChild(empty);
        return;
      }
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        var row = doc.createElement('div');
        row.className = 'gdh-item';

        var link = doc.createElement('a');
        link.className = 'gdh-title';
        link.href = item.webUrl;
        link.textContent = '!' + item.iid + ' ' + item.title;

        var reasons = doc.createElement('span');
        reasons.className = 'gdh-reason';
        reasons.textContent = reasonText(item.reasons);

        row.appendChild(link);
        row.appendChild(reasons);
        list.appendChild(row);
      }
    }

    return {
      node: node,
      setItems: setItems,
      setStatus: function (text, onRetry) {
        status.hidden = !text;
        status.textContent = '';
        if (!text) return;
        status.appendChild(doc.createTextNode(text));
        if (onRetry) {
          var retry = doc.createElement('button');
          retry.type = 'button';
          retry.id = 'gdh-retry';
          retry.className = 'gdh-retry';
          retry.textContent = 'Retry';
          retry.addEventListener('click', onRetry);
          status.appendChild(doc.createTextNode(' '));
          status.appendChild(retry);
        }
      },
      show: function () {
        node.hidden = false;
      },
      hide: function () {
        node.hidden = true;
      },
      isShown: function () {
        return !node.hidden;
      },
    };
  }

  function tabBar(doc) {
    var merged = doc.querySelector('a[href*="state=merged"]');
    if (!merged) return null;
    return merged.closest('ul, nav, [role="tablist"]');
  }

  function mountTab(doc, bar, options) {
    var existing = doc.getElementById('gdh-tab');
    if (existing && existing.parentElement) existing.parentElement.remove();

    var container;
    if (bar) {
      container = doc.createElement('li');
      container.setAttribute('role', 'presentation');
    } else {
      container = doc.createElement('div');
      container.id = 'gdh-bar';
      doc.body.insertBefore(container, doc.body.firstChild);
    }

    var button = doc.createElement('button');
    button.type = 'button';
    button.id = 'gdh-tab';
    button.className = 'gdh-tab';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', 'false');

    var active = false;
    function setActive(value) {
      active = !!value;
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      if (active) button.classList.add('gdh-active');
      else button.classList.remove('gdh-active');
    }

    function setCount(count) {
      button.textContent = 'Hidden (' + (Number(count) || 0) + ')';
    }

    button.addEventListener('click', function () {
      if (active) {
        setActive(false);
        if (options && options.onUnselect) options.onUnselect();
      } else {
        setActive(true);
        if (options && options.onSelect) options.onSelect();
      }
    });

    container.appendChild(button);
    (bar || doc.body).appendChild(container);
    setCount((options && options.count) || 0);

    return {
      button: button,
      container: container,
      setCount: setCount,
      setActive: setActive,
      unmount: function () {
        if (container.parentElement) container.parentElement.removeChild(container);
      },
    };
  }

  root.GDHDom = {
    createRows: createRows,
    createOpenCount: createOpenCount,
    createPanel: createPanel,
    tabBar: tabBar,
    mountTab: mountTab,
  };
})(globalThis);
