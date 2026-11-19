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

Two modes, one behaviour:

- **Base mode** — no setup. Works from what is already on the page. Only
  sees the MRs on the current page (20 by default), so it is a good default
  and an incomplete one.
- **Enhanced mode** — the user adds a GitLab host and a read-only token.
  The extension asks GitLab for every open MR in the project or group, so
  hiding and the Hidden tab are correct across all pages, and counts are
  corrected.

Base is always on. Enhanced is what a token switches on. The same classifier
decides what is hidden in both.

## Goals

- Draft MRs and MRs with a configured label do not appear in the project or
  group Merge requests list.
- A **Hidden** tab beside Open / Merged / Closed / All lists everything that
  was removed, with the reason (draft, or which label), each linking to the MR.
- Base mode works with zero configuration and zero credentials.
- Enhanced mode is complete: all pages, correct counts, reasons for MRs that
  are not on the current page.
- The label list is editable in one place, works across projects and groups,
  and can be exported/imported so a team can share one config.
- Setting up a token is a guided, low-privilege path: `read_api` only, with
  a prefilled GitLab token page link and an explanation of why that is the
  least privilege that works.
- The extension never breaks the page. Any failure fails open — MRs visible
  rather than wrongly hidden.

## Non-goals

- The `/dashboard/merge_requests` page, issue lists, boards, or MR detail
  pages. Project and group MR lists only.
- Hiding anything server-side, or changing what other people see. This is a
  per-browser view.
- Replacing GitLab's list with our own full-featured list (sorting, saved
  views, approval status). We add one tab and one panel.
- Firefox, Safari, Edge-specific work. Manifest V3 Chrome/Chromium.
- A build step, bundler, or framework. Plain ES2022 modules, load unpacked.
- Labels configured per project or per group. One list for the browser.
- "Never hide my own MRs". Deliberately deferred; noted under Future.

## Anti-goals

- A hidden MR that the user cannot find again. If we hide it, the Hidden tab
  must show it.
- Making the counts lie. If we cannot correct a count, we say so instead.
- Asking for "read and change all your data on all websites" at install.
- Any write access to GitLab. The token is read-only and never used for
  anything but listing MRs.

## Constraints

- Chrome MV3. Content scripts cannot be ES modules; the extension ships no
  build step, so shared logic must be loadable both as a content script and
  by tests.
- GitLab's MR list markup is Vue-rendered and changes between versions.
  Selectors must be tolerant, and hiding must key off MR iid (a stable
  anchor URL), not CSS classes.
- Cross-origin API calls are made from the service worker, where granted
  host permissions apply, not from the content script.
- The token must never reach the page's JavaScript context.
- A mono repo can have hundreds of open MRs; the group list can be larger
  still, so paging must be bounded and cached.

## Approaches considered

**A. Filter the page after it loads.** Read the rows GitLab drew, hide
matching ones, list them in the tab. No API, no credentials, smallest
surface. But GitLab renders 20 MRs per page and does not always render every
label chip, so hiding is incomplete and the "Open" count stays wrong.

**B. Ask GitLab for the open MRs, then hide the matching rows.** One REST
call (per page of results) gets every open MR in the project or group with
`draft` and `labels`. We know exactly what is hidden and why, across all
pages, and can correct the count. Costs a token and some fragility.

**C. Replace the list with our own.** Full control, most work, and it
duplicates a screen GitLab maintains.

**Decision (user):** B, with A as the always-available base behaviour — "plan
A is out of the box behaviour, plan B is enhanced mode". B was chosen because
in a mono repo "hidden" has to mean the whole repo, not the current screen.
C was rejected as fighting the host app.

## Decisions taken with the user

- Both surfaces: project and group MR lists.
- Both modes, as above; base mode has no concept of a token.
- Clear, in-app instructions for creating a least-privileged token.

## Decisions taken by the builder (check these)

1. **REST, not GraphQL.** `GET /api/v4/projects/:id/merge_requests` and
   `GET /api/v4/groups/:id/merge_requests`, both `state=opened`,
   `per_page=100`, `with_labels_details=false`. Documented, stable, paginated
   with `X-Next-Page`, and `read_api` is enough. GraphQL with the session's
   CSRF token needs no credential but depends on GitLab's internal schema and
   session handling; a token is the more honest, more revocable path.
2. **Filter client-side, not with the API's `draft`/`labels` parameters.**
   One list, then classify, so we can report *why* each MR is hidden and so
   a change of label list does not change the query shape. A second request
   per label would also multiply rate-limit cost.
3. **No host permissions at install.** `optional_host_permissions` for
   `https://*/*` and `http://*/*`; the options page asks for exactly the host
   the user types, then registers the content script for that origin with
   `chrome.scripting.registerContentScripts`. Install-time warning list stays
   at "storage" and "scripting".
4. **Hide by iid, not by class.** Find `a[href*="/-/merge_requests/<iid>"]`
   in the list, climb to its row (`li`, `[role="listitem"]`, or the nearest
   element containing the row's title), add `data-gdh-hidden="1"` plus a
   stylesheet rule. Never move or remove GitLab's nodes.
5. **Reason model:** `draft` (boolean), `labels` (names that matched), both
   may apply. Shown as chips in the Hidden tab, and the row is hidden if
   either is true.
6. **Base mode is limited and says so:** tab label `Hidden (3)`, plus a hint
   line "Only MRs on this page can be found without a token. Add one in
   settings for the full list." Enhanced mode shows the whole set, including
   MRs not on the current page.
7. **Count correction in enhanced mode only:** subtract the hidden open MRs
   from the "Open" tab count text (best effort, re-applied after re-render).
   Base mode leaves GitLab's count alone, since it is unknowable.
8. **Empty and failure states:** "Nothing hidden — the queue is all ready
   work." A rejected token shows a one-line warning in the panel, falls back
   to base mode for that view, and never hides more than the page shows.
9. **Config is local, shareable by JSON.** `chrome.storage.local` for the
   label list, draft toggle and per-host token; `chrome.storage.sync` is not
   used for the token (it would ship a credential to Google's servers).
   Export/import of the non-secret config only.
10. **Popup is a status strip**, not a second settings screen: mode, host,
    hidden count for the current tab, a pause toggle for this host, and a
    link to settings.
11. **Defaults:** draft hiding on; label list empty, with one-click
    suggestions (`dependencies`, `do-not-merge`, `skip-review`, `on-hold`).
    Shipping a preselected `dependencies` would hide MRs on first run that
    nobody agreed to hide.
12. **Labels match case-insensitively, exact name** (not substring), against
    GitLab's label names. `dependencies` does not match `dependencies-java`.
13. **Bound the paging:** follow `X-Next-Page` up to 10 pages (1000 MRs).
    Beyond that, stop, keep what we have, and say so in the panel.

## How it works

```
GitLab MR list page (project or group)
  │
  ├─ content script (isolated world)
  │    • is this a MR list URL?  /<path>/-/merge_requests   (else idle)
  │    • find rows + iids, read labels/draft hints from the DOM
  │    • ask the service worker for the hidden set
  │    • hide matching rows, fix the Open count, render the Hidden tab
  │    • re-run on Turbo/Vue navigation and DOM re-render
  │
  └─ service worker
       • holds the token, never exposes it
       • base mode: no call, answer "use the page"
       • enhanced: GET project/group MRs (opened, per_page=100, paged)
       • caches per host+scope for 60s, classifies with the shared lib
       • returns [{iid, title, webUrl, reasons, author, updatedAt}]
```

The classifier is one pure function used by both paths:

```js
classify(mr, { hideDrafts, labels }) ->
  { hidden: boolean, reasons: ["draft" | "label:<name>", ...] }
```

### DOM adapter (tolerant by design)

- Identify list rows by an anchor whose path matches `/-/merge_requests/(\d+)$`.
  Take the first such anchor per row.
- Row element: walk up until an element that also contains the row's title
  text and is a `li`/`div[role="listitem"]`, stopping after 8 ancestors.
  Give up quietly if nothing matches.
- Base-mode draft signal: title text matches
  `/^\s*(\[draft\]|\(draft\)|draft:|wip:|\[wip\]|\(wip\))/i`, or the row
  contains a badge whose text is exactly `Draft`.
- Base-mode label signal: text of label chips in the row, matched against the
  configured labels. Chips are found by `[data-testid*="label"], .gl-label,
  .issuable-label` and their text trimmed. Truncated chips ("+2") are ignored;
  that is one of the reasons base mode is approximate.
- Hidden tab button: appended to the tab bar found by locating the element
  containing links whose URLs carry `state=opened` and `state=merged`. If no
  tab bar is found, render a standalone bar above the list instead.
- Clicking a GitLab tab while the Hidden panel is open closes it and restores
  the list. Our tab is `role="tab"`, keyboard reachable, `aria-selected`.

### API

```
GET {host}/api/v4/projects/{url-encoded path}/merge_requests?state=opened&per_page=100&page=N
GET {host}/api/v4/groups/{url-encoded path}/merge_requests?state=opened&per_page=100&page=N
Header: PRIVATE-TOKEN: <token>
```

Group endpoint includes subgroups. Fields used: `iid`, `title`, `web_url`,
`draft`, `labels[]`, `author.username`, `updated_at`. 401 → token invalid;
403 → no visibility; 404 → wrong host/path; 429 → rate limited, keep cache.

Path parsing: project vs group is decided from the URL — GitLab serves the
same `/-/merge_requests` path for both, so ask the API once with the group
endpoint when the path has no more specific signal, or resolve via
`GET /api/v4/namespaces/:id`? Simpler and deterministic: try the project
endpoint; on 404 try the group endpoint; cache which one worked per path.
State this in the plan; a cheaper alternative is to read the page's own
breadcrumb/`data-*` attributes, which is brittle.

## Settings (options page)

Sections, top to bottom:

1. **What this does** — two lines, and the current mode.
2. **Hide drafts** — toggle, on by default.
3. **Labels that mean "not ready"** — chip input, add/remove,
   suggestion buttons. Help text: matches the label name exactly, ignoring
   case.
4. **GitLab hosts** — one card per host: URL, token field (masked, save
   only), Test connection, Remove. Add host asks for permission to that
   origin on click.
5. **Enhanced mode: the token** — the guided part:
   - Which scope and why: a **legacy personal access token with only
     `read_api`**. It can read MRs and nothing else; it cannot push, merge,
     approve, or change settings.
   - A direct link: `{host}/-/user_settings/personal_access_tokens?name=GitLab+Draft+Hider&scopes=read_api`
     (GitLab prefills name and scope).
   - Steps: avatar → Edit profile → Access → Personal access tokens →
     Generate token → Legacy token → expiry (90 days suggested) → check only
     `read_api` → Generate → copy.
   - Alternatives, least privilege first: a **group or project access token**
     with `read_api` and the Reporter role, if the instance allows one (scoped
     to one group/repo, revocable by the owner, not tied to a person); or a
     fine-grained personal access token limited to reading merge requests, if
     the instance offers them.
   - Where it is stored: `chrome.storage.local` in this browser profile only,
     never synced, never sent anywhere except the host above, never exposed to
     the GitLab page.
   - Good hygiene: 90-day expiry, rotate, revoke when you stop using it.
6. **Share this configuration** — Export JSON / Import JSON (labels and
   toggles only, never tokens).
7. **Pause on this site** — same control as the popup.

## Files

```
manifest.json
README.md
icons/icon16.png icon32.png icon48.png icon128.png
src/lib/classify.js          pure classifier + label/draft matching (dual-use)
src/lib/hosts.js            host normalisation, URL/path parsing, scope detection
src/lib/gitlab.js           REST client, paging, error mapping, shape mapping
src/lib/config.js           storage schema, defaults, export/import
src/background/service-worker.js   message router, token holder, API calls, cache
src/content/content.js       DOM adapter, hiding, Hidden tab, re-render observer
src/content/content.css      hiding rule, tab, panel, dark-mode-aware
src/options/options.html|js|css
src/popup/popup.html|js|css
tests/classify.test.js
tests/hosts.test.js
```

`src/lib/classify.js` is written as a classic script that assigns
`globalThis.GDHClassify` (content scripts cannot import modules); tests load
it with `node:vm` so no build step and no dependencies are needed.

Message protocol between content script and service worker:
`gdh:get-hidden { scope: {kind, path}, hostUrl }` → `{ mode, items[], truncated, warning }`.

## Risks and mitigations

- **GitLab markup changes.** iid-anchored row lookup, no class dependency,
  fail open, and a console warning instead of a broken page.
- **Token in browser storage.** Local only, `read_api`, options page explains
  revocation, never sent to the page, never logged. Documented as a
  deliberate trade-off: the alternative is asking for session cookies, which
  is worse.
- **Rate limits / big mono repo.** 100 per page, 10 pages, 60s cache,
  refresh button, and an explicit "showing first 1000" note.
- **Count correction fighting Vue re-renders.** MutationObserver is
  debounced and only touches the count text node, re-applying idempotently.
- **Ambiguous project vs group path.** Try project, fall back to group, cache
  the answer per path.
- **Base mode hiding something the tab cannot list.** Impossible by
  construction: the tab is built from the same rows we hid.

## Testing

- `node --test tests/` — classifier (draft prefixes, exact case-insensitive
  labels, both reasons, no false positives on `dependencies-java`) and URL
  parsing (project vs group, subgroup paths, `/-/merge_requests` only).
- Manual matrix in `README.md`: project list, group list, subgroup list,
  base mode, enhanced mode, bad token, 100+ MRs, light/dark theme, keyboard
  use of the tab, page reload and in-app navigation.
- Manual check that a private project's MRs are not visible before a token is
  added (base mode must not leak titles it should not see — it only reads what
  the page already shows).

## Future (not in this build)

- "Never hide MRs I authored or am assigned to" toggle.
- Per-host or per-project label lists.
- Extra hide rules: no reviewer, stale for N days, pipeline failing.
- Options: show hidden count in the toolbar badge.

## Open items for the planner

- Whether the Hidden tab should reflect itself in the URL (`?hidden=1`) so a
  reload keeps it open. Not required; the plan may decide.
- Exact final wording of the token instructions, to be written in the options
  page and `README.md` from the steps above.
