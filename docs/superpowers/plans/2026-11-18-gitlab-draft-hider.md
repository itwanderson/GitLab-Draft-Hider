# GitLab Draft Hider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome extension that hides draft and parked merge requests from GitLab's project and group Merge requests lists and shows them in a new Hidden tab.

**Architecture:** One content script on the GitLab origin does everything user-visible. A pure classifier decides what is hidden from MR data. Two data sources feed it: the page's own rows (instant, first paint, fallback) and a same-origin GraphQL `query` on the page's existing session (complete, all pages). A service worker holds settings, host grants, content-script registration and the per-tab toolbar icon. No credential exists anywhere, and the extension can only ever issue read queries.

**Tech Stack:** Manifest V3, vanilla ES2022, classic scripts for content-script shared code, `node:test` for unit tests, `linkedom` as a dev-only DOM shim, `rsvg-convert` at authoring time only to produce PNG icons. No bundler, no runtime dependency, no build step.

**Spec:** `docs/superpowers/specs/2026-11-18-gitlab-draft-hider-design.md`

## Global Constraints

- Chrome/Chromium MV3 only. The extension must load unpacked with no build step and no runtime dependency.
- **No credential of any kind.** No tokens, no `storage.session` secret, no OAuth. Only `query` GraphQL operations, only same-origin `POST <prefix>/api/graphql`, with `X-CSRF-Token` read from `meta[name="csrf-token"]` per request.
- Manifest permissions are exactly `storage`, `scripting`, `activeTab`. No `host_permissions`, no `<all_urls>`. Static content script match is only `https://gitlab.com/*`; other hosts come from `optional_host_permissions` (`https://*/*`, `http://*/*`) granted at runtime.
- Shared libs are classic scripts: `(function (root) { … root.GDHName = {…}; })(globalThis);` with no top-level `await`. Tests load them with `node:vm`.
- Never move, remove, or re-parent GitLab's nodes. Only add `data-gdh-hidden="1"`, our own elements, and one text-node correction for the Open count.
- Fail open. Any failed selector, request or schema assumption leaves MRs visible and logs with `console.debug` only. No MR titles, URLs or user names in logs at `console.*` above `debug`.
- Idempotent re-runs: every injected node and every mark is looked up before being added or applied. MutationObserver work is debounced to 150 ms.
- Fixed copy: tooltips and status lines exactly as in the spec's "Toolbar icon" table and decision 8. Badge text is the hidden count capped at `99+`.
- Bounds: 100 MRs per page, 10 pages (1000 MRs), 60 s success cache, 150 ms debounce.
- Hidden applies only when the list state is `opened` or `all`. Nothing is hidden on `merged`/`closed`, and our tab is not mounted there.
- Labels match case-insensitively by exact name after trimming; never by substring.
- Dark mode: all our CSS uses GitLab tokens with light fallbacks and `color-scheme` aware values; no hard-coded white backgrounds.
- Tests: `node --test tests/`. `linkedom` is a devDependency only; `package.json` has no `dependencies`.
- Commits: one per task, message prefix `feat:`, `test:`, `fix:` or `chore:` as fits.

## Review Focus

The spec implies these, no task's happy-path test exercises them, and each is a plausible user-visible failure. Each is pinned by the test named beside it.

1. **A group list where `!12` exists in three projects.** A row must hide only when its own project path and iid both match, and the Hidden tab must not merge the three into one line. → `tests/reconcile.test.js` "keeps identical iids in different projects separate".
2. **Titles that merely start with draft-ish words.** `Drafting the plan`, `WIPping up`, `[Draft] x`, `DRAFT: x`, `(wip) x` — only the last three kinds hide. → `tests/classify.test.js` "does not treat Drafting as a draft".
3. **Labels that contain a configured label as a prefix.** `dependencies` configured must not hide `dependencies-java`, `Dependencies` must hide `dependencies`. → `tests/classify.test.js` "matches labels exactly".
4. **A list URL carrying a filter we do not understand.** Hiding must still happen and the Open count must not be corrected; the panel line is copy, checked in Task 11's manual steps. → `tests/reconcile.test.js` "skips count correction when filters are unknown".
5. **A session that returns a sign-in page instead of JSON.** Must degrade to page-only without throwing, without hiding on the strength of parsed login HTML, and without an unhandled rejection. → `tests/graphql.test.js` "treats an HTML response as signed out".

---

### Task 1: Test harness and classifier

**Files:**
- Create: `package.json`
- Create: `tests/helpers/load.js`
- Create: `src/lib/classify.js`
- Test: `tests/classify.test.js`
- Modify: `docs/superpowers/specs/2026-11-18-gitlab-draft-hider-design.md` (Testing section: dev-only `linkedom` allowed)

**Interfaces:**
- Produces: `globalThis.GDHClassify = { isDraftTitle(title), normalizeLabel(s), matchLabels(mrLabels, configured), classify(entry, options) }`
  - `entry: { draft: boolean, labels: string[] }`
  - `options: { hideDrafts: boolean, labels: string[] }`
  - `classify → { hidden: boolean, reasons: string[] }`, reasons are `"draft"` then `"label:<MR's label spelling>"` in configured order, deduped.
- Produces: `loadGlobal(file, key)` test helper.

- [ ] **Step 1: Write the failing test**

```js
// tests/classify.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load.js';
const { isDraftTitle, matchLabels, classify } = loadGlobal('classify.js', 'GDHClassify');

test('recognises GitLab draft prefixes', () => {
  for (const t of ['DRAFT: fix', 'Draft: fix', '[Draft] fix', '(draft) fix', 'WIP: fix', '[WIP] fix']) {
    assert.equal(isDraftTitle(t), true, t);
  }
});

test('does not treat Drafting as a draft', () => {
  for (const t of ['Drafting the plan', 'WIPping up', 'Redraft: maybe', 'fix: draft handling']) {
    assert.equal(isDraftTitle(t), false, t);
  }
});

test('matches labels exactly', () => {
  assert.deepEqual(matchLabels(['Dependencies', 'backend'], ['dependencies']), ['Dependencies']);
  assert.deepEqual(matchLabels(['dependencies-java'], ['dependencies']), []);
  assert.deepEqual(matchLabels(['  Do-Not-Merge '], ['do-not-merge']), ['  Do-Not-Merge ']);
});

test('classify reports draft and label reasons, draft first', () => {
  const r = classify({ draft: true, labels: ['on-hold', 'dependencies'] },
                      { hideDrafts: true, labels: ['dependencies', 'on-hold'] });
  assert.deepEqual(r, { hidden: true, reasons: ['draft', 'label:dependencies', 'label:on-hold'] });
});

test('classify keeps parked MRs visible when nothing matches', () => {
  assert.deepEqual(classify({ draft: false, labels: ['backend'] }, { hideDrafts: true, labels: ['dependencies'] }),
                   { hidden: false, reasons: [] });
  assert.deepEqual(classify({ draft: true, labels: [] }, { hideDrafts: false, labels: [] }),
                   { hidden: false, reasons: [] });
});
```

```js
// tests/helpers/load.js
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
export function loadGlobal(file, key) {
  const ctx = vm.createContext({});
  const path = new URL(`../../src/lib/${file}`, import.meta.url);
  vm.runInContext(readFileSync(path, 'utf8'), ctx, { filename: path.pathname });
  if (!ctx[key]) throw new Error(`src/lib/${file} did not define ${key}`);
  return ctx[key];
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/classify.test.js`
Expected: FAIL, `Cannot find module` or `did not define GDHClassify`.

- [ ] **Step 3: Implement**

`package.json`:

```json
{ "name": "gitlab-draft-hider", "private": true, "type": "module",
  "scripts": { "test": "node --test tests/" }, "devDependencies": {} }
```

`src/lib/classify.js`: classic-script wrapper; `isDraftTitle` uses
`/^\s*(\[draft\]|\(draft\)|draft:|wip:|\[wip\]|\(wip\))/i`; `normalizeLabel` trims,
collapses inner whitespace, lowercases; `matchLabels` returns the MR's original
spelling for each configured label whose normalized form matches exactly;
`classify` composes them, `reasons` draft-first and deduped.

Also amend the spec's Testing section: replace "no build step and no dependencies
are needed" with the same sentence plus "`linkedom` is a test-only devDependency;
the extension itself has no dependencies."

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/classify.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add package.json src/lib/classify.js tests/helpers/load.js tests/classify.test.js docs/superpowers/specs
git commit -m "feat: classifier for draft and labelled merge requests"
```

---

### Task 2: Loadable extension skeleton

**Files:**
- Create: `manifest.json`
- Create: `src/content/content.js` (stub that reports idle), `src/content/content.css`
- Create: `src/background/service-worker.js` (stub)
- Create: `src/options/options.html`, `src/popup/popup.html` (minimal, replaced in Tasks 11–12)
- Test: `tests/manifest.test.js`

**Interfaces:**
- Produces: `manifest.json` whose `content_scripts[0].js` order is
  `src/lib/classify.js`, `src/lib/hosts.js`, `src/lib/config.js`, `src/lib/graphql.js`, `src/lib/dom.js`, `src/lib/reconcile.js`, `src/content/content.js`.
- Produces: stub files at every manifest-referenced path so the extension loads.

- [ ] **Step 1: Write the failing test**

```js
// tests/manifest.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const m = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

test('asks for the narrowest permissions', () => {
  assert.deepEqual([...m.permissions].sort(), ['activeTab', 'scripting', 'storage']);
  assert.equal(m.host_permissions, undefined);
  assert.ok(!JSON.stringify(m).includes('<all_urls>'));
  assert.deepEqual([...m.optional_host_permissions].sort(), ['http://*/*', 'https://*/*']);
});

test('injects statically only on gitlab.com', () => {
  assert.deepEqual(m.content_scripts.map(c => c.matches), [['https://gitlab.com/*']]);
});

test('every referenced file exists, in load order', () => {
  const paths = [m.background.service_worker, m.options_ui.page, m.action.default_popup,
    ...m.content_scripts[0].js, ...m.content_scripts[0].css];
  for (const p of paths) assert.ok(existsSync(new URL(`../${p}`, import.meta.url)), p);
  const js = m.content_scripts[0].js;
  assert.ok(js.indexOf('src/lib/classify.js') < js.indexOf('src/lib/reconcile.js'));
  assert.equal(js.at(-1), 'src/content/content.js');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/manifest.test.js`
Expected: FAIL, ENOENT for `manifest.json`.

- [ ] **Step 3: Implement**

`manifest.json`: `manifest_version: 3`, name `GitLab Draft Hider`, version `0.1.0`,
the permissions in Global Constraints, `background.service_worker`,
`options_ui: { page: "src/options/options.html", open_in_tab: true }`,
`action: { default_popup: "src/popup/popup.html", default_title: "GitLab Draft Hider" }`,
one content script with `runAt: "document_idle"`, the js order above, and
`css: ["src/content/content.css"]`.

Stubs: `content.js` sets
`document.documentElement.dataset.gdhLoaded = '1'`; `content.css` contains only a
comment; `service-worker.js` is empty apart from `'use strict';`; both HTML files
are minimal valid pages with a heading. Create `src/lib/hosts.js`,
`config.js`, `graphql.js`, `dom.js`, `reconcile.js` as empty classic-script
wrappers so the manifest paths exist (their contents arrive in Tasks 3–6).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/manifest.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Manual check**

Load `chrome://extensions` → Developer mode → Load unpacked → repo root. Expected:
no errors, and `document.documentElement.dataset.gdhLoaded === '1'` on a gitlab.com
Merge requests page.

- [ ] **Step 6: Commit**

```bash
git add manifest.json src tests/manifest.test.js
git commit -m "feat: loadable MV3 skeleton with narrow permissions"
```

---

### Task 3: Host URLs, scope paths and filters

**Files:**
- Modify: `src/lib/hosts.js`
- Test: `tests/hosts.test.js`

**Interfaces:**
- Produces: `globalThis.GDHHosts`
  - `normalizeBaseUrl(input) → { origin, prefix } | null` — `prefix` is `""` or starts with `/` and has no trailing slash.
  - `isMergeRequestListUrl(url, base) → boolean` — path ends with `/-/merge_requests`.
  - `parseListUrl(url, base) → { path, state, filters, unknownFilters } | null`
    - `path`: scope path with no leading/trailing slash (may contain `/`), URL-decoded.
    - `state`: `'opened' | 'all' | 'merged' | 'closed' | null` (absent → `null`, treated as opened).
    - `filters`: `{ labels: string[], author: string|null, assignees: string[], milestone: string|null, search: string|null, scope: 'created_by_me'|'assigned_to_me'|'reviews_for_me'|null, draft: 'yes'|'no'|null }`.
    - `unknownFilters`: query keys outside the known-irrelevant allowlist (`state`, `sort`, `page`, `per_page`, `utf8`, `nav_source`) and outside the filter keys.
  - `graphqlUrl(base) → string` — `origin + prefix + '/api/graphql'`.
  - `matchPattern(base) → string` — `origin + prefix + '/*'`.
  - `identityFromHref(href, base) → { path, iid } | null`.
  - `resolveBase(href, hosts) → { origin, prefix } | null` — first host whose
    `url` is a path-prefix of `href`, longest match wins; `https://gitlab.com`
    always resolves.
  - `registrationFor(base) → { id, matches, js, css, runAt }` — `id` is `gdh-` plus origin+prefix with every non `[A-Za-z0-9_-]` run replaced by `-`.

- [ ] **Step 1: Write the failing test**

```js
// tests/hosts.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load.js';
const H = loadGlobal('hosts.js', 'GDHHosts');

test('normalises hosts with and without an install subpath', () => {
  assert.deepEqual(H.normalizeBaseUrl('https://gitlab.com/'), { origin: 'https://gitlab.com', prefix: '' });
  assert.deepEqual(H.normalizeBaseUrl(' https://example.com/gitlab/ '), { origin: 'https://example.com', prefix: '/gitlab' });
  assert.equal(H.normalizeBaseUrl('ftp://x'), null);
  assert.equal(H.normalizeBaseUrl('not a url'), null);
});

test('parses project, group and subgroup lists, and refuses detail pages', () => {
  const base = { origin: 'https://gitlab.com', prefix: '' };
  assert.equal(H.isMergeRequestListUrl('https://gitlab.com/g/p/-/merge_requests', base), true);
  assert.equal(H.isMergeRequestListUrl('https://gitlab.com/g/p/-/merge_requests/12', base), false);
  assert.deepEqual(H.parseListUrl('https://gitlab.com/g/sub/p/-/merge_requests', base).path, 'g/sub/p');
  assert.equal(H.parseListUrl('https://gitlab.com/g/p/issues', base), null);
});

test('isolates the subpath install from the scope path', () => {
  const base = { origin: 'https://example.com', prefix: '/gitlab' };
  const r = H.parseListUrl('https://example.com/gitlab/mygroup/proj/-/merge_requests?state=opened', base);
  assert.equal(r.path, 'mygroup/proj');
  assert.equal(H.graphqlUrl(base), 'https://example.com/gitlab/api/graphql');
  assert.equal(H.matchPattern(base), 'https://example.com/gitlab/*');
  assert.deepEqual(H.identityFromHref('https://example.com/gitlab/mygroup/proj/-/merge_requests/12', base),
                   { path: 'mygroup/proj', iid: 12 });
});

test('resolves the base for a page from the configured hosts', () => {
  const hosts = [{ url: 'https://example.com/gitlab' }, { url: 'https://example.com/gitlab/deep' }];
  assert.deepEqual(H.resolveBase('https://example.com/gitlab/deep/g/p/-/merge_requests', hosts),
                   { origin: 'https://example.com', prefix: '/gitlab/deep' });
  assert.equal(H.resolveBase('https://example.com/gitlabx/g/p/-/merge_requests', hosts), null);
  assert.deepEqual(H.resolveBase('https://gitlab.com/g/p/-/merge_requests', []),
                   { origin: 'https://gitlab.com', prefix: '' });
});

test('maps filters and flags the ones it does not understand', () => {
  const base = { origin: 'https://gitlab.com', prefix: '' };
  const r = H.parseListUrl('https://gitlab.com/g/p/-/merge_requests?state=all&label_name[]=dependencies&label_name[]=do-not-merge&author_username=ana&search=login&sort=created_date&timeframe=month', base);
  assert.equal(r.state, 'all');
  assert.deepEqual(r.filters.labels, ['dependencies', 'do-not-merge']);
  assert.equal(r.filters.author, 'ana');
  assert.equal(r.filters.search, 'login');
  assert.deepEqual(r.unknownFilters, ['timeframe']);
});

test('builds stable, legal registration ids', () => {
  assert.equal(H.registrationFor({ origin: 'https://example.com', prefix: '/gitlab' }).id, 'gdh-https-example-com-gitlab');
  assert.equal(H.registrationFor({ origin: 'https://gitlab.com', prefix: '' }).id, 'gdh-https-gitlab-com');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/hosts.test.js`
Expected: FAIL, `did not define GDHHosts`.

- [ ] **Step 3: Implement `src/lib/hosts.js`**

Use `new URL()` for parsing and `URLSearchParams` for filters. Take the last
occurrence of `/-/merge_requests` when splitting the path. Percent-decode the
scope path. Treat a missing `state` as `null`. Clamp `state` to the five known
values, `null` otherwise.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/hosts.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hosts.js tests/hosts.test.js
git commit -m "feat: parse GitLab list URLs, filters and identity"
```

---

### Task 4: Configuration store

**Files:**
- Modify: `src/lib/config.js`
- Test: `tests/config.test.js`

**Interfaces:**
- Produces: `globalThis.GDHConfig`
  - `DEFAULTS = { version: 1, hideDrafts: true, labels: [], hosts: [], pausedHosts: [] }`
  - `createConfig(area)` where `area` is `{ get(key), set(obj) }` (both promise-returning). Returns `{ read(), patch(partial), addLabel(name), removeLabel(name), addHost(url), removeHost(hostId), paused(hostKey), setPaused(hostKey, bool), exportJson(), importJson(text) }`.
  - Stored under key `gdh.config`. All mutators resolve to the new config.
  - `addLabel` trims, rejects empty, dedupes case-insensitively keeping the first spelling.
  - `addHost` uses `GDHHosts.normalizeBaseUrl`; stores `{ url: origin + prefix, id: registrationFor(base).id }`; dedupes by `id`.
  - `exportJson() → JSON string` of `{ version: 1, hideDrafts, labels }` only.
  - `importJson(text)` validates shape and version, throws `Error('invalid config')` otherwise; never imports `hosts`, `pausedHosts` or anything unknown.

- [ ] **Step 1: Write the failing test**

```js
// tests/config.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const ctx = vm.createContext({});
for (const f of ['hosts.js', 'config.js']) vm.runInContext(readFileSync(new URL(`../src/lib/${f}`, import.meta.url), 'utf8'), ctx);
const { createConfig } = ctx.GDHConfig;

function memoryArea() {
  let box = {};
  return { get: async () => ({ ...box }), set: async (o) => { box = { ...box, ...o }; }, dump: () => box };
}

test('starts from defaults and persists a patch', async () => {
  const area = memoryArea(); const c = createConfig(area);
  assert.equal((await c.read()).hideDrafts, true);
  await c.patch({ hideDrafts: false });
  assert.equal((await createConfig(area).read()).hideDrafts, false);
});

test('dedupes labels case-insensitively, keeping the first spelling', async () => {
  const c = createConfig(memoryArea());
  await c.addLabel('Dependencies'); await c.addLabel('dependencies'); await c.addLabel('  ');
  assert.deepEqual((await c.read()).labels, ['Dependencies']);
});

test('adds hosts once, by registration id', async () => {
  const c = createConfig(memoryArea());
  await c.addHost('https://example.com/gitlab/'); await c.addHost('https://example.com/gitlab');
  const { hosts } = await c.read();
  assert.deepEqual(hosts, [{ url: 'https://example.com/gitlab', id: 'gdh-https-example-com-gitlab' }]);
});

test('exports only labels and toggles, and re-imports them', async () => {
  const c = createConfig(memoryArea());
  await c.addLabel('on-hold'); await c.addHost('https://example.com'); await c.setPaused('https://example.com', true);
  const json = await c.exportJson();
  assert.deepEqual(JSON.parse(json), { version: 1, hideDrafts: true, labels: ['on-hold'] });
  const other = createConfig(memoryArea());
  await other.importJson(json);
  assert.deepEqual((await other.read()).labels, ['on-hold']);
  await assert.rejects(() => other.importJson('{"version":9}'), /invalid config/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/config.test.js`
Expected: FAIL, `cannot read properties of undefined` or missing `createConfig`.

- [ ] **Step 3: Implement `src/lib/config.js`**

Read-modify-write through `area`; never keep a module-level copy. `read()` merges
stored values over `DEFAULTS` and drops unknown keys. `patch` accepts only
`hideDrafts`, `labels`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/config.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.js tests/config.test.js
git commit -m "feat: local config with import and export"
```

---

### Task 5: GraphQL query, mapping and errors

**Files:**
- Modify: `src/lib/graphql.js`
- Test: `tests/graphql.test.js`

**Interfaces:**
- Produces: `globalThis.GDHGraphql`
  - `QUERY` — one document selecting `project(fullPath:)` and `group(fullPath:, includeSubgroups: true)`, each `mergeRequests(state: opened, first: 100, after: $after, labels: $labels, authorUsername: $author, assigneeUsernames: $assignees, milestoneTitle: $milestone, search: $search, draft: $draft)` with `pageInfo { hasNextPage endCursor }` and nodes `{ iid title webUrl draft updatedAt author { username } project { fullPath } labels { nodes { title } } }`.
  - `buildVariables({ path, filters, after }) → object` — `$labels` omitted when empty, `$assignees` omitted when empty, `$draft` mapped from `filters.draft === 'yes' ? true : filters.draft === 'no' ? false : undefined`.
  - `mapResponse(json) → { scope: 'project'|'group'|null, entries, hasNextPage, endCursor }`, entries as `{ path, iid, title, webUrl, draft, labels: string[], author, updatedAt }`.
  - `classifyError({ status, contentType, body }) → { kind: 'signed-out'|'forbidden'|'rate-limited'|'schema'|'network'|'unknown', message }`.
  - `createClient({ fetchImpl, endpoint, csrfToken, maxPages = 10 }) → { fetchAll({ path, filters }) }` where `fetchAll` resolves `{ entries, truncated, scope }` and rejects with an `Error` whose `kind` comes from `classifyError`.

- [ ] **Step 1: Write the failing test**

```js
// tests/graphql.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load.js';
const G = loadGlobal('graphql.js', 'GDHGraphql');

const page = (nodes, hasNextPage = false, endCursor = null) => ({
  data: { project: { mergeRequests: { pageInfo: { hasNextPage, endCursor }, nodes } }, group: null },
});
const node = (iid, path = 'g/p') => ({ iid, title: `MR ${iid}`, webUrl: `https://gitlab.com/${path}/-/merge_requests/${iid}`,
  draft: iid === 1, updatedAt: '2026-01-01T00:00:00Z', author: { username: 'ana' },
  project: { fullPath: path }, labels: { nodes: [{ title: 'backend' }] } });

test('maps nodes and keeps the project path with the iid', () => {
  const r = G.mapResponse(page([node(1), node(2, 'g/other')]));
  assert.equal(r.scope, 'project');
  assert.deepEqual(r.entries[0], { path: 'g/p', iid: 1, title: 'MR 1',
    webUrl: 'https://gitlab.com/g/p/-/merge_requests/1', draft: true, labels: ['backend'],
    author: 'ana', updatedAt: '2026-01-01T00:00:00Z' });
  assert.equal(r.entries[1].path, 'g/other');
});

test('builds variables and omits empty filters', () => {
  assert.deepEqual(G.buildVariables({ path: 'g/p', filters: { labels: ['a'], draft: 'yes' }, after: 'c1' }),
    { fullPath: 'g/p', after: 'c1', labels: ['a'], draft: true });
  assert.deepEqual(G.buildVariables({ path: 'g/p', filters: {}, after: null }), { fullPath: 'g/p' });
});

test('reports null scope when neither project nor group answers', () => {
  assert.deepEqual(G.mapResponse({ data: { project: null, group: null } }),
                   { scope: null, entries: [], hasNextPage: false, endCursor: null });
});

test('treats an HTML response as signed out', () => {
  assert.equal(G.classifyError({ status: 200, contentType: 'text/html', body: '<html>sign in</html>' }).kind, 'signed-out');
  assert.equal(G.classifyError({ status: 401, contentType: 'application/json', body: '{}' }).kind, 'signed-out');
  assert.equal(G.classifyError({ status: 429 }).kind, 'rate-limited');
  assert.equal(G.classifyError({ status: 200, contentType: 'application/json', body: JSON.stringify({ errors: [{ message: 'x' }] }) }).kind, 'schema');
});

test('pages until hasNextPage is false', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body).variables.after);
    const json = calls.length === 1 ? page([node(1)], true, 'c1') : page([node(2)]);
    return { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]),
             text: async () => JSON.stringify(json) };
  };
  const r = await G.createClient({ fetchImpl, endpoint: 'https://x/api/graphql', csrfToken: 't' })
    .fetchAll({ path: 'g/p', filters: {} });
  assert.deepEqual(calls, [undefined, 'c1']);
  assert.deepEqual(r.entries.map(e => e.iid), [1, 2]);
  assert.equal(r.truncated, false);
});

test('stops at maxPages and reports truncation', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200,
    headers: new Map([['content-type', 'application/json']]),
    text: async () => JSON.stringify(page([node(3)], true, 'next')) });
  const r = await G.createClient({ fetchImpl, endpoint: 'https://x/api/graphql', csrfToken: 't', maxPages: 3 })
    .fetchAll({ path: 'g/p', filters: {} });
  assert.equal(r.entries.length, 3);
  assert.equal(r.truncated, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/graphql.test.js`
Expected: FAIL, `did not define GDHGraphql`.

- [ ] **Step 3: Implement `src/lib/graphql.js`**

Headers: `{ 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }`,
`credentials: 'same-origin'`, `method: 'POST'`, `body: JSON.stringify({ query: QUERY, variables })`.
Read `content-type` from `res.headers.get?.('content-type') ?? res.headers.get('content-type')`.
Page until `hasNextPage` is false or `maxPages` is reached. Wrap network throws as
`kind: 'network'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/graphql.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/graphql.js tests/graphql.test.js
git commit -m "feat: same-origin GraphQL query, paging and error mapping"
```

---

### Task 6: Reconcile page rows with the session answer

**Files:**
- Modify: `src/lib/reconcile.js`
- Test: `tests/reconcile.test.js`

**Interfaces:**
- Consumes: `GDHClassify.classify`, `GDHHosts.identityFromHref` (for `keyOf` only).
- Produces: `globalThis.GDHReconcile`
  - `keyOf(entry) → string` — `` `${entry.path}!${entry.iid}` ``.
  - `pagePass(rows, config) → { hide: Set<string>, items: Item[] }` — `rows` are `{ path, iid, title, href, draft, labels }` (draft already combined from title and badge by the DOM adapter).
  - `sessionPass(entries, config) → { hide: Set<string>, items: Item[] }`.
  - `merge(page, session, { unknownFilters }) → { hide: Set<string>, items: Item[], countDelta: number }` — union of keys, items deduped by key (session spelling wins), `countDelta = unknownFilters ? 0 : session.items.length`.
  - `Item = { path, iid, title, webUrl, reasons: string[] }`.

- [ ] **Step 1: Write the failing test**

```js
// tests/reconcile.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const ctx = vm.createContext({});
for (const f of ['classify.js', 'hosts.js', 'reconcile.js']) vm.runInContext(readFileSync(new URL(`../src/lib/${f}`, import.meta.url), 'utf8'), ctx);
const R = ctx.GDHReconcile;
const cfg = { hideDrafts: true, labels: ['dependencies'] };

const row = (path, iid, extra = {}) => ({ path, iid, title: `MR ${iid}`, href: `https://gitlab.com/${path}/-/merge_requests/${iid}`, draft: false, labels: [], ...extra });
const entry = (path, iid, extra = {}) => ({ path, iid, title: `MR ${iid}`, webUrl: `https://gitlab.com/${path}/-/merge_requests/${iid}`, draft: false, labels: [], ...extra });

test('hides drafts and configured labels from page rows', () => {
  const r = R.pagePass([row('g/p', 1, { draft: true }), row('g/p', 2, { labels: ['dependencies'] }), row('g/p', 3)], cfg);
  assert.deepEqual([...r.hide].sort(), ['g/p!1', 'g/p!2']);
  assert.deepEqual(r.items.map(i => [i.iid, i.reasons]), [[1, ['draft']], [2, ['label:dependencies']]]);
});

test('keeps identical iids in different projects separate', () => {
  const r = R.sessionPass([entry('g/a', 12, { draft: true }), entry('g/b', 12, { labels: ['dependencies'] }), entry('g/c', 12)], cfg);
  assert.deepEqual([...r.hide].sort(), ['g/a!12', 'g/b!12']);
  assert.deepEqual(r.items.map(i => i.path), ['g/a', 'g/b']);
});

test('unions both passes and de-duplicates items by key', () => {
  const page = R.pagePass([row('g/p', 1, { draft: true })], cfg);
  const session = R.sessionPass([entry('g/p', 1, { draft: true })], cfg);
  const m = R.merge(page, session, { unknownFilters: [] });
  assert.deepEqual([...m.hide], ['g/p!1']);
  assert.equal(m.items.length, 1);
  assert.equal(m.countDelta, 1);
});

test('skips count correction when filters are unknown', () => {
  const session = R.sessionPass([entry('g/p', 1, { draft: true })], cfg);
  assert.equal(R.merge(R.pagePass([], cfg), session, { unknownFilters: ['timeframe'] }).countDelta, 0);
  assert.equal(R.merge(R.pagePass([], cfg), session, { unknownFilters: [] }).countDelta, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/reconcile.test.js`
Expected: FAIL, `did not define GDHReconcile`.

- [ ] **Step 3: Implement `src/lib/reconcile.js`**

`keyOf` is `path + "!" + iid`. `pagePass` calls `classify({ draft, labels }, cfg)` per
row. `sessionPass` the same over entries. `merge` builds a `Map` keyed by `keyOf`
(session first, then page items whose key is absent), so nothing hidden is ever
missing from the tab.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/reconcile.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reconcile.js tests/reconcile.test.js
git commit -m "feat: reconcile page rows with the session answer"
```

---

### Task 7: Toolbar icon state, badges and assets

**Files:**
- Create: `src/lib/iconState.js`, `tests/iconState.test.js`
- Create: `assets/icons/funnel-{full,page,paused,idle}.svg`
- Create: `tools/make-icons.sh` and the generated `icons/icon-{16,32}-{full,page,paused,idle}.png`, `icons/icon-48.png`, `icons/icon-128.png`
- Modify: `manifest.json` (`icons`, `action.default_icon`), `src/content/content.js` (include `iconState.js`? no — service worker only), `manifest.json` content script list unchanged.

**Interfaces:**
- Produces: `globalThis.GDHIcons`
  - `stateFor({ state, hiddenCount, reason }) → { state, badge, title }` — `state` is
    `'full'|'page'|'paused'|'idle'` exactly as the content script reports it;
    `reason` is `'signed-out'|'error'` (default `'signed-out'`) and only changes the
    `page` tooltip. The returned object has exactly those three keys.
  - `badgeText(n) → string` — `''` for 0, `'99+'` above 99, else decimal.
  - `assetPath(state, size) → string` — `icons/icon-${size}-${state}.png` for 16/32; `icons/icon-${size}.png` for 48/128.
  - `pathsFor(state) → { 16: string, 32: string }` — what `chrome.action.setIcon` takes.

- [ ] **Step 1: Write the failing test**

```js
// tests/iconState.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load.js';
const I = loadGlobal('iconState.js', 'GDHIcons');

test('reports the source in the tooltip', () => {
  assert.deepEqual(I.stateFor({ state: 'full', hiddenCount: 5 }),
    { state: 'full', badge: '5', title: 'GitLab Draft Hider — full list, 5 hidden' });
  assert.equal(I.stateFor({ state: 'page', hiddenCount: 5, reason: 'signed-out' }).title,
    'GitLab Draft Hider — this page only: signed out');
  assert.equal(I.stateFor({ state: 'page', hiddenCount: 5, reason: 'error' }).title,
    "GitLab Draft Hider — this page only: GitLab didn't answer");
});

test('paused and idle have no count', () => {
  assert.deepEqual(I.stateFor({ state: 'paused', hiddenCount: 5 }),
    { state: 'paused', badge: '', title: 'GitLab Draft Hider — paused on this GitLab' });
  assert.deepEqual(I.stateFor({ state: 'idle', hiddenCount: 0 }),
    { state: 'idle', badge: '', title: 'GitLab Draft Hider — open a Merge requests list' });
});

test('caps the badge and hides zero', () => {
  assert.equal(I.badgeText(0), '');
  assert.equal(I.badgeText(7), '7');
  assert.equal(I.badgeText(120), '99+');
});

test('maps states to the asset files', () => {
  assert.equal(I.assetPath('page', 16), 'icons/icon-16-page.png');
  assert.equal(I.assetPath('full', 128), 'icons/icon-128.png');
  assert.deepEqual(I.pathsFor('paused'), { 16: 'icons/icon-16-paused.png', 32: 'icons/icon-32-paused.png' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/iconState.test.js`
Expected: FAIL, `did not define GDHIcons`.

- [ ] **Step 3: Implement `src/lib/iconState.js` and the assets**

`stateFor` passes the reported state through and derives the badge (empty for
`paused`/`idle`). Tooltips exactly: `GitLab Draft Hider — full list, ${badge} hidden`,
`GitLab Draft Hider — this page only: signed out`, `GitLab Draft Hider — paused on this GitLab`,
`GitLab Draft Hider — open a Merge requests list`. When the degraded reason is a
failed query instead of no session, the content script sends
`source: 'page'` and the title uses `this page only: GitLab didn't answer` — so
`stateFor` also accepts `{ reason: 'signed-out'|'error' }` and picks the tail of
the tooltip from it (default `signed-out`).

Four SVG sources at a 24 viewBox, funnel path
`M3.2 4.6h17.6l-7.1 8.1v6.2l-3.4 1.8v-8L3.2 4.6Z`:
`full` filled `#6366f1`; `page` stroked `#8a8f98` with the lower third filled
`#f59e0b` (clip rect `y=13.4`); `paused` stroked plus a diagonal line; `idle`
stroked, dashed `2.4 2.2`. `tools/make-icons.sh` runs
`rsvg-convert -w 16 -h 16 … -o icons/icon-16-<state>.png` for 16 and 32, and
`rsvg-convert -w 48/128` from `funnel-full.svg` for the extension page icons.
Commit the PNGs. Extend `manifest.json` with
`"icons": { "48": "icons/icon-48.png", "128": "icons/icon-128.png" }` and
`"action": { …, "default_icon": { "16": "icons/icon-16-idle.png", "32": "icons/icon-32-idle.png" } }`.

- [ ] **Step 4: Run tests and check the manifest**

Run: `node --test tests/iconState.test.js tests/manifest.test.js`
Expected: PASS. Then `rsvg-convert` produced all ten PNGs (`ls icons/`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/iconState.js tests/iconState.test.js assets tools icons manifest.json
git commit -m "feat: toolbar icon states and badges"
```

---

### Task 8: Service worker — per-tab icon, host grants, registration

**Files:**
- Modify: `src/background/service-worker.js`
- Create: `tests/serviceWorker.test.js` (tests the pure handler with injected fakes)

**Interfaces:**
- Consumes: `GDHConfig`, `GDHHosts`, `GDHIcons`, loaded in the worker with
  `importScripts('/src/lib/hosts.js', '/src/lib/config.js', '/src/lib/iconState.js', …)`.
- Produces: message handlers, all reply `{ ok, … }`:
  - `gdh:status { state, hiddenCount, reason }` → sets icon/badge/title for `sender.tab.id`.
  - `gdh:get-config` → `{ config }`.
  - `gdh:set-config { patch }` → `{ config }`.
  - `gdh:set-paused { hostKey, paused }` → `{ config }`.
  - `gdh:add-host { url }` → `{ ok: true, host }` or `{ ok: false, error: 'invalid'|'registration-failed' }`.
  - `gdh:forget-host { id }` → `{ config }`.
- Produces: `createHandlers({ action, tabs, permissions, scripting, runtime, area })`
  returning `{ onMessage, onUpdated, onRemoved }` so tests can drive it with fakes.
- **The worker never calls `permissions.request`.** Chrome requires a user gesture in
  a document, so the options page and popup call it in their click handlers and only
  then send `gdh:add-host`. The worker validates, registers and persists.

- [ ] **Step 1: Write the failing test**

```js
// tests/serviceWorker.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
// Load the pure handler factory only; chrome wiring is a thin wrapper around it.
const ctx = vm.createContext({});
for (const f of ['hosts.js', 'config.js', 'iconState.js', 'serviceWorkerCore.js'])
  vm.runInContext(readFileSync(new URL(`../src/${f.startsWith('service') ? 'background/' : 'lib/'}${f}`, import.meta.url), 'utf8'), ctx);
const { createHandlers } = ctx.GDHServiceWorker;

const fakes = () => {
  const calls = { icon: [], badge: [], title: [], registered: [], unregistered: [] };
  let box = {};
  return {
    calls,
    area: { get: async () => ({ ...box }), set: async (o) => { box = { ...box, ...o }; } },
    action: { setIcon: (o) => calls.icon.push(o), setBadgeText: (o) => calls.badge.push(o),
              setBadgeBackgroundColor: () => {}, setTitle: (o) => calls.title.push(o) },
    tabs: { onUpdated: { addListener() {} } },
    permissions: { remove: async () => true, onRemoved: { addListener() {} } },
    scripting: { registerContentScripts: async (o) => calls.registered.push(o),
                 unregisterContentScripts: async (o) => calls.unregistered.push(o),
                 executeScript: async () => [] },
    runtime: { onMessage: { addListener() {} }, id: 'self' },
  };
};

test('status sets the icon for that tab only', async () => {
  const f = fakes(); const h = createHandlers(f);
  await h.onMessage({ type: 'gdh:status', state: 'full', hiddenCount: 5, reason: 'signed-out' }, { tab: { id: 7 }, id: 'self' });
  assert.equal(f.calls.icon.at(-1).tabId, 7);
  assert.equal(f.calls.icon.at(-1).path['16'], 'icons/icon-16-full.png');
  assert.equal(f.calls.badge.at(-1).text, '5');
});

test('ignores messages from another extension', async () => {
  const f = fakes(); const h = createHandlers(f);
  const r = await h.onMessage({ type: 'gdh:status' }, { tab: { id: 7 }, id: 'other' });
  assert.equal(r.ok, false);
  assert.equal(f.calls.icon.length, 0);
});

test('navigation start resets a tab to idle', async () => {
  const f = fakes(); const h = createHandlers(f);
  await h.onUpdated(7, { status: 'loading' });
  assert.equal(f.calls.icon.at(-1).path['16'], 'icons/icon-16-idle.png');
  assert.equal(f.calls.badge.at(-1).text, '');
});

test('adding an already-granted host registers exactly that origin and path', async () => {
  const f = fakes(); const h = createHandlers(f);
  const r = await h.onMessage({ type: 'gdh:add-host', url: 'https://example.com/gitlab' }, { id: 'self' });
  assert.equal(r.ok, true);
  assert.equal(f.calls.registered.at(-1)[0].id, 'gdh-https-example-com-gitlab');
  assert.deepEqual(f.calls.registered.at(-1)[0].matches, ['https://example.com/gitlab/*']);
  assert.equal(f.calls.registered.at(-1)[0].persistAcrossSessions, true);
});

test('adding garbage changes nothing', async () => {
  const f = fakes(); const h = createHandlers(f);
  const r = await h.onMessage({ type: 'gdh:add-host', url: 'not a url' }, { id: 'self' });
  assert.deepEqual(r, { ok: false, error: 'invalid' });
  assert.equal(f.calls.registered.length, 0);
});

test('a revoked grant unregisters that host and forgets it', async () => {
  const f = fakes(); const h = createHandlers(f);
  await h.onMessage({ type: 'gdh:add-host', url: 'https://example.com/gitlab' }, { id: 'self' });
  const r = await h.onRemoved({ origins: ['https://example.com/gitlab/*'] });
  assert.deepEqual(f.calls.unregistered.at(-1), { ids: ['gdh-https-example-com-gitlab'] });
  assert.deepEqual(r.hosts, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/serviceWorker.test.js`
Expected: FAIL, `did not define GDHServiceWorker`.

- [ ] **Step 3: Implement**

`src/background/serviceWorkerCore.js` holds `createHandlers` (classic script,
assigns `globalThis.GDHServiceWorker`). `src/background/service-worker.js` is the
thin wiring:

```js
importScripts('/src/lib/hosts.js', '/src/lib/config.js', '/src/lib/iconState.js',
              '/src/background/serviceWorkerCore.js');
const handlers = GDHServiceWorker.createHandlers({
  action: chrome.action, tabs: chrome.tabs, permissions: chrome.permissions,
  scripting: chrome.scripting, runtime: chrome.runtime, area: chrome.storage.local,
});
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  handlers.onMessage(msg, sender).then(reply, (e) => reply({ ok: false, error: String(e) }));
  return true;
});
chrome.tabs.onUpdated.addListener((id, info) => { if (info.status === 'loading') handlers.onUpdated(id, info); });
chrome.permissions.onRemoved.addListener((p) => handlers.onRemoved(p));
```

Add `src/background/serviceWorkerCore.js` to the manifest? No — service worker
files are loaded by `importScripts`, not listed. `web_accessible_resources` is
not needed.

`gdh:add-host`: `normalizeBaseUrl` → `registrationFor(base)` →
`scripting.registerContentScripts([{ ...registration, persistAcrossSessions: true }])`
→ `config.addHost` → `scripting.executeScript` into currently matching tabs (best
effort; a failure here is not an error, the next navigation injects). Registration
failure replies `{ ok: false, error: 'registration-failed' }` and stores nothing.
On `permissions.onRemoved`, find the stored host whose `matchPattern` equals the
removed origin, unregister its `id`, `config.removeHost` it, and reply with the new
config.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/serviceWorker.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Manual check**

Reload the extension. Expected: no service-worker errors; clicking the action on a
non-list page shows the idle icon and no badge; on a list page (Task 9 wires the
status) the icon changes.

- [ ] **Step 6: Commit**

```bash
git add src/background tests/serviceWorker.test.js
git commit -m "feat: per-tab icon, host grants and runtime registration"
```

---

### Task 9: DOM adapter — rows, hiding, count, tab bar and panel

**Files:**
- Modify: `src/lib/dom.js`
- Create: `tests/fixtures/list.html`, `tests/dom.test.js`
- Modify: `package.json` (add `linkedom` devDependency)

**Interfaces:**
- Produces: `globalThis.GDHDom`
  - `createRows(doc, base) → { read(): Row[], hide(key, on), unhideAll(hiddenKeys) }` where `Row = { el, path, iid, href, title, draft, labels }`. `draft` is `GDHClassify.isDraftTitle(title) || row has a badge whose trimmed text is exactly 'Draft'`. `labels` is the trimmed text of `[data-testid*="label"], .gl-label, .issuable-label` inside the row, skipping any that start with `+` (truncation chips). Duplicate anchors to the same key yield one row.
  - `createOpenCount(doc) → { adjust(delta), reset() }` — finds the Open tab link (`a[href*="state=opened"]`) and its numeric text; stores the original in `dataset.gdhBaseCount`; renders `base - delta` (never below 0); `reset` restores.
  - `createPanel(doc) → { node, setItems(items), setStatus(text|null), show(), hide(), isShown() }` — `node` is `<div id="gdh-panel" role="tabpanel">` appended after the list container.
  - `mountTab(doc, bar, { count, onSelect, onUnselect }) → { button, container, setCount(n), setActive(bool), unmount() }` — appends a `role="tab"` button to `bar` when it is non-null, else creates a standalone `#gdh-bar` before the list and returns it as `container`. `setCount` writes `Hidden (n)`.
  - `tabBar(doc) → Element|null`.

- [ ] **Step 1: Write the fixture and the failing test**

`tests/fixtures/list.html` mirrors GitLab's list: a `<ul>` of `<li class="merge-request">`
with `<a class="gl-link" href="https://gitlab.com/g/p/-/merge_requests/482">Fix flaky login spec</a>`,
a duplicate reference anchor in the same row (`…/merge_requests/482` again), label chips
(`<span class="gl-label">dependencies</span>`), one row with `<span class="gl-label">dependencies-java</span>`,
one with a `Draft` badge, one whose title is `Drafting the plan`, one group-style row for
`g/other`, and a tab bar `<ul><li><a href="?state=opened">Open <span>37</span></a></li>…<li><a href="?state=merged">Merged</a></li></ul>`.

```js
// tests/dom.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
const ctx = vm.createContext({});
for (const f of ['classify.js', 'hosts.js', 'dom.js'])
  vm.runInContext(readFileSync(new URL(`../src/lib/${f}`, import.meta.url), 'utf8'), ctx);
const html = readFileSync(new URL('./fixtures/list.html', import.meta.url), 'utf8');

const setup = () => { const { document } = parseHTML(html); return { doc: document,
  rows: ctx.GDHDom.createRows(document, { origin: 'https://gitlab.com', prefix: '' }) }; };

test('reads one row per iid with identity and signals', () => {
  const { rows } = setup(); const all = rows.read();
  assert.equal(new Set(all.map(r => `${r.path}!${r.iid}`)).size, all.length);
  const byKey = Object.fromEntries(all.map(r => [`${r.path}!${r.iid}`, r]));
  assert.equal(byKey['g/p!482'].draft, false);
  assert.deepEqual(byKey['g/p!482'].labels, ['dependencies']);
  assert.deepEqual(byKey['g/p!470'].labels, ['dependencies-java']);
  assert.equal(byKey['g/p!476'].draft, true);
  assert.equal(byKey['g/p!461'].draft, true);   // badge only
  assert.equal(byKey['g/p!450'].draft, false);  // "Drafting the plan"
});

test('hides and unhides without removing nodes', () => {
  const { rows } = setup(); const before = rows.read().length;
  rows.hide('g/p!482', true);
  assert.equal(rows.read().filter(r => r.el.getAttribute('data-gdh-hidden') === '1').length, 1);
  assert.equal(rows.read().length, before);
  rows.hide('g/p!482', false);
  assert.equal(rows.read().filter(r => r.el.getAttribute('data-gdh-hidden') === '1').length, 0);
});

test('adjusts the Open count from the original value and never goes negative', () => {
  const { doc } = setup(); const c = ctx.GDHDom.createOpenCount(doc);
  c.adjust(5); assert.match(doc.querySelector('a[href*="state=opened"]').textContent, /32/);
  c.adjust(100); assert.match(doc.querySelector('a[href*="state=opened"]').textContent, /0/);
  c.reset(); assert.match(doc.querySelector('a[href*="state=opened"]').textContent, /37/);
});

test('mounts an accessible tab and a panel after the list', () => {
  const { doc } = setup();
  const panel = ctx.GDHDom.createPanel(doc);
  const t = ctx.GDHDom.mountTab(doc, ctx.GDHDom.tabBar(doc), { count: 3, onSelect() {}, onUnselect() {} });
  assert.equal(t.button.getAttribute('role'), 'tab');
  assert.equal(t.button.getAttribute('aria-selected'), 'false');
  assert.equal(t.button.textContent, 'Hidden (3)');
  t.setActive(true);
  assert.equal(t.button.getAttribute('aria-selected'), 'true');
  assert.equal(panel.node.getAttribute('role'), 'tabpanel');
  assert.equal(panel.isShown(), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm install --save-dev linkedom && node --test tests/dom.test.js`
Expected: FAIL, `did not define GDHDom`.

- [ ] **Step 3: Implement `src/lib/dom.js`**

Row discovery: `doc.querySelectorAll('a[href*="/-/merge_requests/"]')`, resolve each
with `GDHHosts.identityFromHref`; climb from the anchor while the element is not a
`li`/`[role="listitem"]` and at most 8 levels; dedupe by key. Hidden marks are
`el.setAttribute('data-gdh-hidden', '1')` / `removeAttribute`. Panel and tab are
built with `doc.createElement`, all ids prefixed `gdh-`, and every mount is
idempotent (remove an existing node with the same id first).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/dom.test.js`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/lib/dom.js tests/dom.test.js tests/fixtures
git commit -m "feat: DOM adapter for rows, hiding, count, tab and panel"
```

---

### Task 10: Content script — page pass, panel and lifecycle

**Files:**
- Modify: `src/content/content.js`
- Modify: `src/content/content.css`
- Test: manual (all logic it uses is unit-tested)

**Interfaces:**
- Consumes: `GDHHosts`, `GDHConfig`, `GDHDom`, `GDHReconcile`, `GDHGraphql`, `GDHClassify`.
- Produces: `globalThis.GDHRun = { boot(doc, win, deps) }` (exported for manual debugging), where `deps = { config, fetchHidden }`.

- [ ] **Step 1: Implement the page pass**

`boot`:

```js
const getConfig = () => chrome.runtime.sendMessage({ type: 'gdh:get-config' }).then(r => r.config);

async function boot(doc = document, win = window) {
  const cfg = await getConfig();
  const base = GDHHosts.resolveBase(win.location.href, cfg.hosts);
  if (!base || !GDHHosts.isMergeRequestListUrl(win.location.href, base)) { report({ state: 'idle' }); return; }
  const parsed = GDHHosts.parseListUrl(win.location.href, base);
  if (!['opened', 'all', null].includes(parsed.state)) { report({ state: 'idle' }); return; }
  if (cfg.pausedHosts.includes(base.origin + base.prefix)) { report({ state: 'paused' }); return; }
  const rows = GDHDom.createRows(doc, base);
  const panel = GDHDom.createPanel(doc);
  // pagePass(rows.read(), cfg) → applyMarks → renderPanel → mountTab → report({ state: 'page' })
}
```

Rules that make it testable by eye: one `applyMarks(hideSet)` cell that first
unhides everything it hid last run, then hides the new set; `renderPanel(items)`
rebuilds only the panel's item container; `setStatus` writes a single line and
hides it when `null`.

`content.css`:

```css
[data-gdh-hidden="1"] { display: none !important; }
#gdh-panel { border-top: 1px solid var(--gl-border-color-default, #dcdcde); padding: 12px 0; }
#gdh-panel .gdh-item { display: flex; gap: 8px; align-items: baseline; padding: 6px 0; }
#gdh-panel .gdh-reason { font-size: 12px; color: var(--gl-text-color-subtle, #737278); }
#gdh-panel .gdh-status { font-size: 12px; color: var(--gl-text-color-subtle, #737278); padding-bottom: 8px; }
#gdh-bar { display: flex; gap: 8px; padding: 8px 0; }
.gdh-tab[aria-selected="true"] { font-weight: 600; box-shadow: inset 0 -2px 0 var(--gl-color-blue-500, #1f75cb); }
```

No background colours of our own; text uses inherit or GitLab tokens with dark-safe
fallbacks.

- [ ] **Step 2: Wire the lifecycle**

Re-run on SPA navigation and re-render: a 150 ms debounced `MutationObserver` on
`document.body` that calls `boot()` when `location.href` changed since last run,
and `reconcile()` (re-apply marks from the last computed set) when the list
re-renders without a URL change. Listen to `pagehide` to report idle. Guard every
run with a module-level generation counter so a stale async run cannot apply
marks after a newer run started. Wrap the whole `boot()` in try/catch reporting
`state: 'idle'` on unexpected errors.

- [ ] **Step 3: Report status**

`report({ state, hiddenCount, reason })` → `chrome.runtime.sendMessage({ type: 'gdh:status', … })`,
swallowing "receiving end does not exist". Count = number of hidden items.

- [ ] **Step 4: Manual check**

On a real project's Merge requests list, signed in or out: drafts disappear,
configured labels disappear, "Hidden (n)" appears beside GitLab's tabs, clicking it
shows the hidden MRs with reasons, clicking Open restores the list, the toolbar icon
matches the state, and the Open count drops by n once both this and Task 11 are in.
Hard reload: no flash of drafts (hide happens on first pass).

- [ ] **Step 5: Commit**

```bash
git add src/content
git commit -m "feat: page pass, Hidden tab and lifecycle"
```

---

### Task 11: Content script — session query, counts, reconciliation

**Files:**
- Modify: `src/content/content.js`
- Test: manual plus the unit tests from Tasks 3–6

**Interfaces:**
- Consumes: `GDHGraphql.createClient`, `GDHReconcile.sessionPass/merge`, `GDHDom.createOpenCount`.
- Produces: `fetchHidden(base, parsed, cfg)` inside `content.js`, replaced in tests by injection.

- [ ] **Step 1: Implement the session pass**

```js
async function fetchHidden(base, parsed, cfg) {
  const meta = document.querySelector('meta[name="csrf-token"]');
  if (!meta?.content) return { ok: false, reason: 'signed-out' };
  const client = GDHGraphql.createClient({
    fetchImpl: (u, i) => fetch(u, i), endpoint: GDHHosts.graphqlUrl(base),
    csrfToken: meta.content, maxPages: 10,
  });
  try {
    const r = await client.fetchAll({ path: parsed.path, filters: parsed.filters });
    if (!r.scope) return { ok: false, reason: 'signed-out' };
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, reason: e.kind === 'network' ? 'error' : e.kind };
  }
}
```

Success is cached per `endpoint + path + JSON.stringify(filters)` for 60 s in a
module-level `Map`. On success: `merge(pagePass, sessionPass)`, apply marks, render
panel items (with each item's MR link and reason chips), `count.adjust(countDelta)`
when `parsed.state` is `null` or `opened` and `unknownFilters` is empty,
`count.reset()` otherwise, report `state: 'full'`. On failure: keep the page pass,
report `state: 'page'` with the reason. When `parsed.unknownFilters` is non-empty,
`panel.setStatus('Hidden counts are not adjusted for the filters in this URL.')`.

- [ ] **Step 2: Degrade cleanly**

A failed session pass must not throw, must not retry in a loop (no retry inside the
same run), and must not clear the page-derived marks. A later navigation retries.
`reason: 'signed-out'` renders "Signed out — showing the MRs on this page only";
anything else renders "GitLab didn't answer — showing the MRs on this page only" and
sends `reason: 'error'` so the icon tooltip matches.

- [ ] **Step 3: Manual check**

Signed in on a repo with more than 20 open MRs: a draft on page 2 is hidden on page 1
and appears in the Hidden tab with a reason; the Open count equals GitLab's minus the
hidden open MRs; the icon shows the filled funnel. Sign out in another tab and reload:
the icon goes to the page state, the panel says signed out, and page rows are still
hidden. Apply a label filter: the Hidden tab only lists matching MRs.

- [ ] **Step 4: Commit**

```bash
git add src/content
git commit -m "feat: session query, count correction and full-set reconciliation"
```

---

### Task 12: Options page

**Files:**
- Create: `src/options/options.html`, `src/options/options.js`, `src/options/options.css`

**Interfaces:**
- Consumes: `GDHConfig` (via `chrome.storage.local`), `GDHHosts`, service-worker messages `gdh:get-config`, `gdh:set-config`, `gdh:add-host`, `gdh:forget-host`, `gdh:set-paused`.
- Produces: no new globals.

- [ ] **Step 1: Build the page**

Sections in this order, matching the spec: (1) what it does plus current source line,
(2) hide-drafts switch, (3) label chips with add box and suggestion buttons
(`dependencies`, `do-not-merge`, `skip-review`, `on-hold`), (4) host cards with
Enable/Re-grant, Remove and source status, (5) "How this works without a token"
paragraph, (6) Export/Import JSON with a file input and a download link,
(7) pause for the current host. Every change writes through the worker and re-renders
from the returned config; no optimistic local state.

Copy for section 5, verbatim:

> This extension has no token and stores no secret. It reads the merge request list
> with the GitLab session you are already signed in with, using the same read-only
> query the page itself uses. It can only read what that page can read.

- [ ] **Step 2: Style**

Use the system font, `prefers-color-scheme` for the page background and text, and
`max-width: 720px`. Host cards are bordered blocks; chips are rounded with a remove
button; all inputs have labels; buttons are real `<button>` elements.

- [ ] **Step 2b: Ask for the grant in this page, not in the worker**

The Add-host handler calls `chrome.permissions.request({ origins: [GDHHosts.matchPattern(base)] })`
first, inside the submit event, and only on `true` sends `gdh:add-host` to the worker.
On `false` it shows "Permission denied — this GitLab was not added" and sends nothing.
The popup's "Enable on this GitLab" button does the same thing from its own click handler.

- [ ] **Step 3: Manual check**

Add `https://gitlab.com`, expect the grant prompt naming gitlab.com only. Add
`https://example.com/gitlab`, expect the prompt naming that origin. Deny: the card
says denied and no host is stored. Export downloads JSON without hosts; import
applies labels and toggles and rejects a bad file with an inline error. Keyboard-only
pass works.

- [ ] **Step 4: Commit**

```bash
git add src/options
git commit -m "feat: settings page with hosts, labels and import/export"
```

---

### Task 13: Popup and README

**Files:**
- Create: `src/popup/popup.js`, `src/popup/popup.css`, replace `src/popup/popup.html`
- Create: `README.md`

**Interfaces:**
- Consumes: service-worker messages; `chrome.tabs.query({ active: true, currentWindow: true })`.

- [ ] **Step 1: Build the popup**

Three lines: source ("Full list — 5 hidden" / "This page only — signed out" /
"Paused on this GitLab" / "Open a Merge requests list"), host, and the hidden count.
Actions: Pause/Resume for this host, "Enable on this GitLab" when the current origin
is not in `config.hosts`, Settings link. To decide "is this GitLab", use `activeTab`
(the action click grants it) to read `tab.url` and to run one
`chrome.scripting.executeScript` that returns
`!!document.querySelector('meta[name="csrf-token"]')`; if that is false the popup shows
only "Open a Merge requests list" and Settings. Clicking Enable calls
`chrome.permissions.request` from that click, then `gdh:add-host`. 280 px wide,
`prefers-color-scheme` aware.

- [ ] **Step 2: Write the README**

Sections: what it does, install (load unpacked), use, what "this page only" means,
**no token** explanation, the icon state table, supported pages (project/group
lists, not dashboards or detail pages), self-hosted setup including subpath installs,
tests (`npm install && npm test`), manual QA matrix from the spec, troubleshooting
(signed out, instance blocks GraphQL, unsupported filters, GitLab markup change),
privacy (no network calls except the GraphQL query to your own GitLab; nothing
stored beyond labels/hosts/pause).

- [ ] **Step 3: Manual check**

Popup on a list page shows the count and pauses/resumes; on a non-list page shows the
idle line and no actions beyond Settings; on an ungranted GitLab host offers Enable.

- [ ] **Step 4: Full regression**

Run: `node --test tests/`
Expected: all suites PASS. Then walk the spec's manual matrix once end to end,
including the four icon states in greyscale and `prefers-color-scheme: dark`.

- [ ] **Step 5: Commit**

```bash
git add src/popup README.md
git commit -m "feat: popup status and README"
```

---

## Self-Review

**Spec coverage:** intent and surfaces (Tasks 2, 3, 10), base pass (9, 10), session
query and paging bounds (5, 11), reasons (1, 6), Hidden tab and panel (9, 10),
count correction and its filter caveat (6, 11), degraded states and copy (7, 11),
icon states and assets (7, 8), narrow permissions and runtime registration (2, 3, 8),
subpath installs (3, 8, 12), config, labels and import/export (4, 12), no-credential
stance (5, 11, 12), dark mode and keyboard (9, 12, 13), manual matrix and README (13).

**Known deviation from the spec:** `linkedom` is added as a devDependency so the DOM
adapter is tested rather than only inspected by eye. Task 1 amends the spec's Testing
section; the extension itself still has no dependency and no build step.

**Open item the spec deferred:** whether the Hidden tab reflects itself in the URL.
Not implemented; the panel is client-side only and a reload returns to Open. This is
consistent with decision 8 and needs no task.

**Review Focus tests:** five lines above, each naming its owning test. No line is
left without one.
