# GitLab Draft Hider — design

Date: 2026-11-18

## Intent

A team moving to MR-driven development drowns in merge requests that
are not ready for review: drafts, and MRs carrying labels that mean "don't
look at this yet" (`dependencies`, `do-not-merge`, `skip-review`). In a mono
repo those sit in the same list as the work that is actually ready, so the
queue stops meaning anything.

This extension makes the list mean "ready work" again. It removes drafts
and labelled-as-parked MRs from the normal Merge requests list and puts
them behind a new **Hidden** tab, so nothing is lost and nothing has to be
tracked in someone's head. It works on a project's Merge requests page and
on a group's Merge requests page (which covers subgroups, and is how the
mono repo and the wider team area are viewed).

Two modes, one behaviour, no credentials:

- **Base mode** — no setup. Reads the rows already on the page. Only sees
  the MRs on the current page (20 by default), so it is a good default and
  an incomplete one.
- **Enhanced mode** — asks GitLab for every open MR in the project or group
  through the browser session you are already signed in with. Hiding, the
  Hidden tab and the counts are then correct across all pages.

Base mode is always on. Enhanced mode switches itself on when the request
succeeds. The same classifier decides what is hidden in both.

**There is no token, no key, and no secret to store.** See "Security".

## Goals

- Draft MRs and MRs with a configured label do not appear in the project or
  group Merge requests list.
- A **Hidden** tab beside Open / Merged / Closed / All lists everything that
  was removed, with the reason (draft, or which label), each linking to the MR.
- Base mode works with no configuration.
- Enhanced mode is complete: all pages, correct counts, reasons for MRs that
  are not on the current page, and it respects the filters the user has
  applied to the list.
- The label list is editable in one place, works across projects and groups,
  and can be exported/imported so a team can share one config.
- The extension never breaks the page. Any failure fails open — MRs visible
  rather than wrongly hidden.

## Non-goals

- The `/dashboard/merge_requests` page, issue lists, boards, or MR detail
  pages. Project and group MR lists only.
- Hiding anything server-side, or changing what other people see. This is a
  per-browser view.
- Replacing GitLab's list with our own full-featured list (sorting, saved
  views, approval status). We add one tab and one panel.
- Any credential: no personal access token, no OAuth app, no stored secret.
- Firefox, Safari, Edge-specific work. Manifest V3 Chrome/Chromium.
- A build step, bundler, or framework. Plain ES2022 modules, load unpacked.
- Labels configured per project or per group. One list for the browser.
- "Never hide my own MRs". Deliberately deferred; noted under Future.

## Anti-goals

- A hidden MR that the user cannot find again. If we hide it, the Hidden tab
  must show it.
- Making the counts lie. If we cannot correct a count, we say so instead.
- Asking for "read and change all your data on all websites" at install.
- Any write access to GitLab. The extension only ever sends the GraphQL
  `query` operation — it has no code path that can create, change, merge or
  approve anything.

## Constraints

- Chrome MV3. Content scripts cannot be ES modules; the extension ships no
  build step, so shared logic must be loadable both as a content script and
  by tests.
- GitLab's MR list markup is Vue-rendered and changes between versions.
  Selectors must be tolerant, and hiding must key off MR identity (the row's
  link), not CSS classes.
- GraphQL with the page session requires a same-origin request and the CSRF
  token GitLab puts in a `<meta name="csrf-token">` tag.
- A mono repo can have hundreds of open MRs; the group list can be larger
  still, so paging must be bounded and cached.

## Approaches considered

**A. Filter the page after it loads.** Read the rows GitLab drew, hide
matching ones, list them in the tab. No API, no credentials, smallest
surface. But GitLab renders 20 MRs per page and does not always render every
label chip, so hiding is incomplete and the "Open" count stays wrong.

**B. Ask GitLab for the open MRs, then hide the matching rows.** Same-origin
GraphQL with the page's own session gets every open MR in the project or
group with `draft` and label names. We know exactly what is hidden and why,
across all pages, and can correct the count. Costs a GraphQL query and some
fragility if the schema changes.

**C. Replace the list with our own.** Full control, most work, and it
duplicates a screen GitLab maintains.

**Decision (user):** B, with A as the always-available base behaviour — "plan
A is out of the box behaviour, plan B is enhanced mode". B was chosen because
in a mono repo "hidden" has to mean the whole repo, not the current screen.
C was rejected as fighting the host app.

**Revision after the security question:** B reads through the page's session
rather than a token. An earlier draft used REST with a `read_api` personal
access token; that was dropped because it put a credential in extension
storage for no gain. See "Security".

## Decisions taken with the user

- Both surfaces: project and group MR lists.
- Both modes, as above.
- Secret handling: a leaked key would be problematic, so there is no key.

## Decisions taken by the builder (check these)

1. **Same-origin GraphQL, not REST with a token.** One `query` operation per
   list view, cookies and CSRF come from the page the user is already on.
   Nothing to store, revoke or expire; the extension can do strictly what the
   page can do, which is read.
2. **Injection is static for gitlab.com, opt-in elsewhere.** The manifest
   declares a content script for `https://gitlab.com/*` only — the install
   warning names one site, not every site. Any other GitLab is added in
   settings, which requests that origin (optionally a path prefix) and
   registers a content script at runtime. This is what makes base mode work
   out of the box without `<all_urls>`.
3. **Hide by MR identity, not by class.** Identity is
   `(project full path, iid)`, both taken from the row's link
   (`…/<project>/-/merge_requests/<iid>`). In a group list `!12` exists in
   many projects, so iid alone is not an identity; iid-only is used only on a
   single-project page. Find the row by its anchor, climb to the nearest
   `li`/`[role="listitem"]`, add `data-gdh-hidden="1"`. Never move or remove
   GitLab's nodes.
4. **Mirror the page's filters.** The list URL carries `label_name[]`,
   `author_username`, `assignee_username`, `milestone_title`, `search`,
   `scope`, `draft`. Those map onto the matching GraphQL arguments (for
   `scope`, use `currentUser.username`, fetched once and cached). The Hidden
   tab therefore shows what is hidden *within the current view*, and the count
   correction stays valid. If the URL carries a filter we do not understand,
   we still hide, but we do not correct counts and the panel says "counts not
   adjusted for this filter".
5. **Hiding is about open MRs.** It applies on the Open tab and on All (where
   the same open rows appear). On Merged and Closed we do nothing, and our
   tab is not shown there. The Hidden tab is only offered on Open and All.
   "Clicking another tab closes it and restores the list" means it closes the
   panel and restores visibility for that tab — it does not unhide on Open.
6. **Subpath installs use an explicit base URL.** A host entry is a GitLab
   *URL* that may include a path (`https://example.com/gitlab`). The scope
   path is the remainder after that prefix and `/-/merge_requests`; the API
   base is prefix + `/api/graphql`; the permission pattern is
   `origin + prefix + "/*"`. This removes the "is `gitlab` a group or an
   install path?" ambiguity instead of guessing. `https://gitlab.com` has no
   prefix.
7. **Reason model:** `draft` (boolean), `labels` (names that matched), both
   may apply. Shown as chips in the Hidden tab; the row is hidden if either
   is true.
8. **Base mode is limited and says so:** tab label `Hidden (3)`, plus "Only
   MRs on this page can be found right now. Reload in enhanced mode for the
   full list." Enhanced mode shows the whole set, including MRs not on the
   current page.
9. **Count correction in enhanced mode only**, on the Open tab, subtracting
   the hidden open MRs from the Open count text. Re-applied idempotently
   after re-render. Base mode leaves GitLab's numbers alone.
10. **Empty and failure states:** "Nothing hidden — the queue is all ready
    work." A failed GraphQL call (session expired, schema change, 403) falls
    back to base mode for that view with a one-line note, and never hides
    more than the page shows.
11. **Config is local and shareable by JSON.** Label list and toggles in
    `chrome.storage.local`; export/import of labels and toggles only. No
    secrets exist to export.
12. **Popup is a status strip**: mode, host, hidden count for the current
    tab, a pause toggle for this host, an "Enable on this GitLab" action when
    the current host is not yet granted, and a link to settings.
13. **Defaults:** draft hiding on; label list empty, with one-click
    suggestions (`dependencies`, `do-not-merge`, `skip-review`, `on-hold`).
    Shipping a preselected `dependencies` would hide MRs on first run that
    nobody agreed to hide.
14. **Labels match case-insensitively, exact name** (not substring), against
    GitLab's label names. `dependencies` does not match `dependencies-java`.
15. **Bound the paging:** follow `pageInfo.hasNextPage` up to 10 pages (1000
    MRs). Beyond that, stop, keep what we have, and say so in the panel.

## Security

There is no secret, so there is nothing to store badly. The extension reads
the MR list the same way the page it is injected into does:

- The request is `POST <prefix>/api/graphql` from the content script, so it is
  same-origin with the page: the browser attaches the user's existing GitLab
  session cookie, and the `X-CSRF-Token` header comes from the page's own
  `<meta name="csrf-token">` (read per request, never stored).
- Only `query` operations are ever sent. There is no mutation, no REST write,
  no path by which the extension could change, merge, approve or delete
  anything, even if compromised.
- The extension sees exactly what the page can see — no more. A user without
  access to a project gets nothing for it.
- API calls go through `fetch` in the content script, not the service worker,
  because they must be same-origin to carry the session. No token ever
  crosses a process boundary; no credential is written to `storage.local`,
  `storage.session`, or a log.
- No `externally_connectable`, no `onMessageExternal`: other pages and other
  extensions cannot ask this extension for anything.
- Permissions are per site. `https://gitlab.com/*` at install; other hosts on
  request, from a click, for that origin (and path prefix) only. No
  `<all_urls>`.
- If a future version ever needs a token (for example an instance that blocks
  GraphQL), it must use `chrome.storage.session` only — memory, never on disk
  — with `storage.local.setAccessLevel('TRUSTED_CONTEXTS')`, and `read_api`
  scope. That is a deliberate "not now", not an oversight. Chrome's own
  guidance for sensitive data is session storage; the extension does not
  need even that.

## How it works

```
GitLab MR list page (project or group)
  │
  ├─ content script (isolated world, injected on the GitLab origin)
  │    • is this a MR list URL?  <prefix>/<scope>/-/merge_requests   (else idle)
  │    • parse scope kind, scope path, and the active filters from the URL
  │    • find rows, derive (project path, iid) from each row's link
  │    • base mode: read draft/labels from the DOM
  │    • enhanced: POST the GraphQL query with the page session
  │    • classify, hide rows, fix the Open count, render the Hidden tab
  │    • re-run on Turbo/Vue navigation and (debounced) DOM re-render
  │
  └─ service worker
       • settings, host grants, runtime content-script registration
       • badge with the hidden count (from the content script)
       • no API calls, no credentials
```

The classifier is one pure function used by both paths:

```js
classify(mr, { hideDrafts, labels }) ->
  { hidden: boolean, reasons: ["draft" | "label:<name>", ...] }
```

### GraphQL

Project:

```graphql
query ($fullPath: ID!, $after: String, $labels: [String!], $author: String,
       $assignee: String, $milestone: String, $search: String) {
  project(fullPath: $fullPath) {
    mergeRequests(state: opened, first: 100, after: $after, labels: $labels,
                  authorUsername: $author, assigneeUsername: $assignee,
                  milestoneTitle: $milestone, search: $search) {
      pageInfo { hasNextPage endCursor }
      nodes {
        iid
        title
        webUrl
        draft
        author { username }
        updatedAt
        project { fullPath }
        labels { nodes { title } }
      }
    }
  }
}
```

Group is the same with `group(fullPath: $fullPath, includeSubgroups: true)`.
Group paging is per group, and `includeSubgroups` covers nested projects.

Identity is `project.fullPath + "/" + iid`. The DOM side derives the same
pair from the row's href, so the two sides meet without a lookup table.

### DOM adapter (tolerant by design)

- Identify list rows by an anchor whose path matches
  `/-/merge_requests/(\d+)$`; take the project path from the same href.
- Row element: walk up until an element that also contains the row's title
  text and is a `li`/`div[role="listitem"]`, stopping after 8 ancestors.
  Give up quietly if nothing matches.
- Base-mode draft signal: title text matches
  `/^\s*(\[draft\]|\(draft\)|draft:|wip:|\[wip\]|\(wip\))/i`, or the row
  contains a badge whose text is exactly `Draft`.
- Base-mode label signal: text of label chips in the row, matched against the
  configured labels. Chips are found by `[data-testid*="label"], .gl-label,
  .issuable-label`; truncated chips ("+2") are ignored, which is one of the
  reasons base mode is approximate.
- Hidden tab button: appended to the tab bar found by locating the element
  containing links whose URLs carry `state=opened` and `state=merged`. If no
  tab bar is found, render a standalone bar above the list instead.
- Our tab is `role="tab"`, keyboard reachable, `aria-selected`; the panel has
  `role="tabpanel"`. Clicking any GitLab tab closes our panel and restores
  list visibility for that tab.
- Re-running is idempotent: marks and injected nodes are looked up before
  being added, and the observer is debounced (~150 ms).

### Filters

Parsed from `location.search` and mapped to GraphQL arguments. Anything not
in the map (`label_name[]`, `author_username`, `assignee_username`,
`assignee_username[]`, `milestone_title`, `search`, `scope`, `draft`) is
"unknown": hide from the enhanced set but label the panel "counts not adjusted
for this filter". `page`/`sort`/`state` are irrelevant to the query.

## Settings (options page)

1. **What this does** — two lines, and the current mode (base or enhanced) with
   a one-line reason if enhanced is not available ("not signed in on this
   host", "this GitLab did not answer").
2. **Hide drafts** — toggle, on by default.
3. **Labels that mean "not ready"** — chip input, add/remove, suggestion
   buttons. Help text: matches the label name exactly, ignoring case.
4. **GitLab hosts** — one card per host: URL (may include a path prefix),
   grant/re-grant access, remove, and whether enhanced mode works there.
   Adding asks for permission to that origin on click.
5. **How this works without a token** — two sentences: it uses the session
   you are already signed in with, read-only, nothing stored. (This is where
   the token instructions used to be; they are gone because the token is.)
6. **Share this configuration** — Export JSON / Import JSON (labels and
   toggles only).
7. **Pause on this site** — same control as the popup.

## Files

```
manifest.json
README.md
icons/icon16.png icon32.png icon48.png icon128.png
src/lib/classify.js          pure classifier + label/draft matching (dual-use)
src/lib/hosts.js             base URL/prefix, scope + filter parsing, URL builders
src/lib/graphql.js           query documents, response mapping, error mapping
src/lib/config.js            storage schema, defaults, export/import
src/lib/dom.js               row discovery, (path, iid) extraction, tab/panel DOM
src/background/service-worker.js   settings, host grants, script registration, badge
src/content/content.js       orchestration: detect, fetch, hide, render, observe
src/content/content.css      hiding rule, tab, panel, dark-mode-aware
src/options/options.html|js|css
src/popup/popup.html|js|css
tests/classify.test.js
tests/hosts.test.js
```

`src/lib/classify.js` and `src/lib/hosts.js` are classic scripts that assign
to `globalThis.GDH…` (content scripts cannot import modules); tests load them
with `node:vm`, so no build step and no dependencies are needed. `dom.js` is
tested against fixture HTML via the same trick only if a DOM shim is already
available; otherwise its pure parts (identity extraction from a URL) live in
`hosts.js` and are tested there.

## Risks and mitigations

- **GitLab markup changes.** Identity-anchored row lookup, no class dependency,
  fail open, console warning instead of a broken page.
- **GitLab GraphQL schema changes.** Ten fields, all long-standing and used by
  GitLab's own UI. A failure degrades to base mode for that view; it never
  breaks the page. The queries are isolated in one file so a fix is local.
- **Session expiry.** GraphQL returns 401/redirect; we fall back to base mode
  and say so. Signing in again fixes it.
- **Rate limits / big mono repo.** 100 per page, 10 pages, 60 s cache, refresh
  button, explicit "showing first 1000" note.
- **Count correction fighting Vue re-renders.** MutationObserver is debounced
  and only touches the count text node, re-applying idempotently.
- **Unsupported filter in the URL.** Hide, do not correct counts, say so.
- **Subpath installs.** Explicit base URL with path prefix; permission pattern
  includes it; a wrong prefix fails visibly ("this GitLab did not answer")
  rather than as a 404 that looks like a permission problem.
- **Both modes disagreeing.** The Hidden tab is built from the same set we hid,
  so it cannot omit something hidden. In enhanced mode we hide by identity
  from the API; rows the page has but the API did not return (just-created MR)
  are hidden by the base-mode classifier as a backstop only if they match.

## Testing

- `node --test tests/` — classifier (draft prefixes, exact case-insensitive
  labels, both reasons, no false positives on `dependencies-java`),
  URL parsing (project vs group, subgroup paths, subpath install, filters,
  `/-/merge_requests` only), identity extraction (`path + iid`), and the
  count subtraction.
- Manual matrix in `README.md`: project list, group list, subgroup list, base
  mode, enhanced mode, signed out, 100+ MRs, filters applied, All tab,
  Merged/Closed tabs untouched, light/dark theme, keyboard use of the tab,
  page reload and in-app navigation, self-hosted subpath install.

## Future (not in this build)

- "Never hide MRs I authored or am assigned to" toggle.
- Per-host or per-project label lists.
- Extra hide rules: no reviewer, stale for N days, pipeline failing.
- Toolbar badge with the hidden count (already wired, off by default).
- Optional token path for instances that block GraphQL — session storage only.

## Open items for the planner

- Whether the Hidden tab should reflect itself in the URL (`?hidden=1`) so a
  reload keeps it open. Not required; the plan may decide.
