// Same-origin GraphQL: the read-only data source for the full merge request set.
// Classic script for the same reason as the others; there is no credential here —
// the browser sends the session cookie and we echo the page's CSRF token.
(function (root) {
  'use strict';

  var NODE_FIELDS = [
    'iid', 'title', 'webUrl', 'draft', 'updatedAt',
    'author { username }', 'project { fullPath }', 'labels { nodes { title } }',
  ].join(' ');

  var ARGS = 'state: opened, first: 100, after: $after, labels: $labels, ' +
    'authorUsername: $author, assigneeUsernames: $assignees, reviewerUsername: $reviewer, ' +
    'milestoneTitle: $milestone, search: $search, draft: $draft';

  var QUERY = 'query HiddenScan($fullPath: ID!, $after: String, $labels: [String!], ' +
    '$author: String, $assignees: [String!], $reviewer: String, $milestone: String, ' +
    '$search: String, $draft: Boolean) {\n' +
    '  project(fullPath: $fullPath) { mergeRequests(' + ARGS + ') {' +
    ' pageInfo { hasNextPage endCursor } nodes { ' + NODE_FIELDS + ' } } }\n' +
    '  group(fullPath: $fullPath) { mergeRequests(' + ARGS + ', includeSubgroups: true) {' +
    ' pageInfo { hasNextPage endCursor } nodes { ' + NODE_FIELDS + ' } } }\n' +
    '}';

  var CURRENT_USER = 'query CurrentUser { currentUser { username } }';

  function withoutEmpty(variables) {
    var out = {};
    Object.keys(variables).forEach(function (key) {
      var value = variables[key];
      if (value === undefined || value === null) return;
      if (Array.isArray(value) && value.length === 0) return;
      if (value === '') return;
      out[key] = value;
    });
    return out;
  }

  function buildVariables(input) {
    var filters = (input && input.filters) || {};
    var variables = {
      fullPath: input.path,
      after: input.after,
      labels: filters.labels,
      author: filters.author,
      assignees: filters.assignees,
      milestone: filters.milestone,
      search: filters.search,
      draft: filters.draft === 'yes' ? true : filters.draft === 'no' ? false : undefined,
    };
    // The page's scope filter has no GraphQL equivalent; it is expressed as the
    // same username filter the page itself uses.
    if (filters.scope && input.me) {
      if (filters.scope === 'assigned_to_me') variables.assignees = [input.me];
      if (filters.scope === 'created_by_me') variables.author = input.me;
      if (filters.scope === 'reviews_for_me') variables.reviewer = input.me;
    }
    return withoutEmpty(variables);
  }

  function mapNode(node) {
    var labels = [];
    var connection = node && node.labels && node.labels.nodes;
    if (Array.isArray(connection)) {
      for (var i = 0; i < connection.length; i++) {
        if (connection[i] && typeof connection[i].title === 'string') labels.push(connection[i].title);
      }
    }
    return {
      path: node && node.project ? node.project.fullPath : '',
      iid: node ? node.iid : 0,
      title: node ? node.title : '',
      webUrl: node ? node.webUrl : '',
      draft: !!(node && node.draft),
      labels: labels,
      author: node && node.author ? node.author.username : '',
      updatedAt: node ? node.updatedAt : null,
    };
  }

  function mapResponse(json) {
    var data = (json && json.data) || {};
    var source = data.project || data.group || null;
    if (!source || !source.mergeRequests) {
      return { scope: null, entries: [], hasNextPage: false, endCursor: null };
    }
    var connection = source.mergeRequests;
    var nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
    var entries = [];
    for (var i = 0; i < nodes.length; i++) entries.push(mapNode(nodes[i]));
    return {
      scope: data.project ? 'project' : 'group',
      entries: entries,
      hasNextPage: !!(connection.pageInfo && connection.pageInfo.hasNextPage),
      endCursor: connection.pageInfo ? connection.pageInfo.endCursor : null,
    };
  }

  function classifyError(input) {
    var status = (input && input.status) || 0;
    var contentType = (input && input.contentType) || '';
    var body = (input && input.body) || '';
    if (/text\/html/i.test(contentType)) {
      return { kind: 'signed-out', message: 'GitLab answered with a page instead of data — the session is not signed in.' };
    }
    if (status === 401) return { kind: 'signed-out', message: 'GitLab rejected the request: not signed in.' };
    if (status === 403) return { kind: 'forbidden', message: 'GitLab refused this project or group for the current account.' };
    if (status === 429) return { kind: 'rate-limited', message: 'GitLab rate-limited the request; keeping the page-only result.' };
    if (status >= 500) return { kind: 'network', message: 'GitLab had a server error.' };
    if (typeof body === 'string' && body.indexOf('"errors"') !== -1) {
      return { kind: 'schema', message: 'GitLab rejected the query — its schema has moved.' };
    }
    return { kind: 'unknown', message: 'The query did not produce merge requests.' };
  }

  function errorFrom(info) {
    var error = new Error(info.message);
    error.kind = info.kind;
    return error;
  }

  function headerValue(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    return headers[name] || '';
  }

  function createClient(options) {
    var fetchImpl = options.fetchImpl;
    var endpoint = options.endpoint;
    var csrfToken = options.csrfToken;
    var maxPages = options.maxPages || 10;

    async function post(query, variables) {
      var response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
          body: JSON.stringify({ query: query, variables: variables }),
        });
      } catch (e) {
        throw errorFrom({ kind: 'network', message: 'Could not reach GitLab.' });
      }
      var contentType = headerValue(response.headers, 'content-type');
      var text = '';
      try {
        text = await response.text();
      } catch (e) {
        text = '';
      }
      if (!response.ok || /text\/html/i.test(contentType)) {
        throw errorFrom(classifyError({ status: response.status, contentType: contentType, body: text }));
      }
      var json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        throw errorFrom(classifyError({ status: response.status, contentType: contentType, body: text }));
      }
      if (json && Array.isArray(json.errors) && json.errors.length) {
        throw errorFrom(classifyError({ status: response.status, contentType: contentType, body: text }));
      }
      return json;
    }

    async function fetchAll(input) {
      var entries = [];
      var after = null;
      var hasNextPage = false;
      var endCursor = null;
      var scope = null;
      var pages = 0;
      while (pages < maxPages) {
        var json = await post(QUERY, buildVariables({
          path: input.path, filters: input.filters || {}, after: after, me: input.me,
        }));
        var page = mapResponse(json);
        if (!page.scope) return { entries: [], truncated: false, scope: null };
        scope = page.scope;
        entries = entries.concat(page.entries);
        hasNextPage = page.hasNextPage;
        endCursor = page.endCursor;
        pages++;
        if (!hasNextPage) break;
        after = endCursor;
      }
      return { entries: entries, truncated: hasNextPage, scope: scope };
    }

    async function fetchUsername() {
      var json = await post(CURRENT_USER, {});
      return json && json.data && json.data.currentUser ? json.data.currentUser.username : null;
    }

    return { fetchAll: fetchAll, fetchUsername: fetchUsername };
  }

  root.GDHGraphql = {
    QUERY: QUERY,
    buildVariables: buildVariables,
    mapResponse: mapResponse,
    classifyError: classifyError,
    createClient: createClient,
  };
})(globalThis);
