// URL, scope and filter parsing for GitLab merge request lists.
// Classic script: content scripts cannot use ES modules and the extension ships
// no build step, so the module assigns itself to globalThis.
(function (root) {
  'use strict';

  var LIST_SUFFIX = /\/-\/merge_requests\/?$/;
  var DETAIL_SUFFIX = /\/-\/merge_requests\/(\d+)\/?$/;
  var STATES = ['opened', 'all', 'merged', 'closed', 'locked'];
  var SCOPES = ['all', 'created_by_me', 'assigned_to_me', 'reviews_for_me'];
  // Query keys that do not change which MRs the list contains.
  var IGNORED_KEYS = ['state', 'sort', 'page', 'per_page', 'utf8', 'nav_source'];
  var FILTER_KEYS = [
    'label_name[]', 'label_name',
    'author_username',
    'assignee_username[]', 'assignee_username',
    'milestone_title', 'search', 'scope', 'draft',
  ];

  var CONTENT_JS = [
    'src/lib/classify.js',
    'src/lib/hosts.js',
    'src/lib/config.js',
    'src/lib/graphql.js',
    'src/lib/dom.js',
    'src/lib/reconcile.js',
    'src/content/content.js',
  ];

  function toUrl(value) {
    try {
      return new URL(String(value));
    } catch (e) {
      return null;
    }
  }

  function normalizeBaseUrl(input) {
    if (typeof input !== 'string') return null;
    var url = toUrl(input.trim());
    if (!url) return null;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.search || url.hash || url.username || url.password) return null;
    var path = url.pathname.replace(/\/+$/, '');
    return { origin: url.origin, prefix: path };
  }

  function withinBase(url, base) {
    if (!base || url.origin !== base.origin) return false;
    if (!base.prefix) return true;
    return url.pathname === base.prefix || url.pathname.indexOf(base.prefix + '/') === 0;
  }

  function isMergeRequestListUrl(href, base) {
    var url = toUrl(href);
    if (!url || !withinBase(url, base)) return false;
    var rest = url.pathname.slice(base.prefix.length);
    return LIST_SUFFIX.test(rest);
  }

  function parseListUrl(href, base) {
    var url = toUrl(href);
    if (!url || !withinBase(url, base) || !LIST_SUFFIX.test(url.pathname.slice(base.prefix.length))) return null;

    var rest = url.pathname.slice(base.prefix.length).replace(LIST_SUFFIX, '');
    var path = rest.replace(/^\/+|\/+$/g, '');
    if (!path) return null;
    try {
      path = decodeURIComponent(path);
    } catch (e) {
      /* keep the encoded form when it is not valid percent-encoding */
    }

    var params = url.searchParams;
    var state = params.get('state');
    if (state !== null && STATES.indexOf(state) === -1) state = null;

    var unknown = [];
    var scopeValue = params.get('scope');
    if (scopeValue !== null && SCOPES.indexOf(scopeValue) === -1) {
      unknown.push('scope');
      scopeValue = null;
    }
    // GitLab's own filter form serialises scope=all; that is "no scope filter".
    if (scopeValue === 'all') scopeValue = null;
    var draftValue = params.get('draft');
    if (draftValue !== null && draftValue !== 'yes' && draftValue !== 'no') {
      unknown.push('draft');
      draftValue = null;
    }

    var allKeys = [];
    params.forEach(function (value, key) {
      allKeys.push(key);
    });
    for (var i = 0; i < allKeys.length; i++) {
      var key = allKeys[i];
      if (IGNORED_KEYS.indexOf(key) !== -1 || FILTER_KEYS.indexOf(key) !== -1) continue;
      if (unknown.indexOf(key) === -1) unknown.push(key);
    }

    return {
      path: path,
      state: state,
      filters: {
        labels: params.getAll('label_name[]').concat(params.getAll('label_name')),
        author: params.get('author_username'),
        assignees: params.getAll('assignee_username[]').concat(params.getAll('assignee_username')),
        milestone: params.get('milestone_title'),
        search: params.get('search'),
        scope: scopeValue,
        draft: draftValue,
      },
      unknownFilters: unknown,
    };
  }

  function identityFromHref(href, base) {
    var url = toUrl(href);
    if (!url || !withinBase(url, base)) return null;
    var match = DETAIL_SUFFIX.exec(url.pathname);
    if (!match) return null;
    var path = url.pathname.slice(base.prefix.length, match.index).replace(/^\/+|\/+$/g, '');
    if (!path) return null;
    try {
      path = decodeURIComponent(path);
    } catch (e) {
      /* keep the encoded form */
    }
    return { path: path, iid: Number(match[1]) };
  }

  function graphqlUrl(base) {
    return base.origin + base.prefix + '/api/graphql';
  }

  function matchPattern(base) {
    return base.origin + base.prefix + '/*';
  }

  function registrationFor(base) {
    var id = 'gdh-' + (base.origin + base.prefix).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return {
      id: id,
      matches: [matchPattern(base)],
      js: CONTENT_JS.slice(),
      css: ['src/content/content.css'],
      runAt: 'document_idle',
    };
  }

  function resolveBase(href, hosts) {
    var url = toUrl(href);
    if (!url) return null;
    var candidates = [{ origin: 'https://gitlab.com', prefix: '' }];
    var list = hosts || [];
    for (var i = 0; i < list.length; i++) {
      var base = normalizeBaseUrl(list[i] && list[i].url);
      if (base) candidates.push(base);
    }
    var best = null;
    var bestLength = -1;
    for (var j = 0; j < candidates.length; j++) {
      var candidate = candidates[j];
      if (!withinBase(url, candidate)) continue;
      if (candidate.prefix.length > bestLength) {
        best = candidate;
        bestLength = candidate.prefix.length;
      }
    }
    return best;
  }

  root.GDHHosts = {
    normalizeBaseUrl: normalizeBaseUrl,
    isMergeRequestListUrl: isMergeRequestListUrl,
    parseListUrl: parseListUrl,
    identityFromHref: identityFromHref,
    graphqlUrl: graphqlUrl,
    matchPattern: matchPattern,
    registrationFor: registrationFor,
    resolveBase: resolveBase,
  };
})(globalThis);
