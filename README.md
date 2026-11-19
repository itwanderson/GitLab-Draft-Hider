# GitLab Draft Hider

A Chrome extension that takes draft and parked merge requests out of GitLab's merge request
lists and puts them in a **Hidden** tab, so the list only shows work that is ready.

Works on a project's Merge requests page and on a group's Merge requests page (including
subgroups), which is how a mono repo or a whole team area is usually viewed.

- Hides drafts (`Draft:`, `DRAFT:`, `[Draft]`, `(draft)`, `WIP:` and GitLab's own draft badge).
- Hides any merge request carrying a label you choose (`dependencies`, `do-not-merge`, …).
- Adds a **Hidden (n)** tab listing everything removed, with the reason and a link to each MR.
- Corrects the Open count when it knows the full set.
- **No token, no key, no stored secret.**

## Install

**From a release:** download `gitlab-draft-hider.zip` from the latest release, unzip it, then
`chrome://extensions` → Developer mode → **Load unpacked** → pick the unzipped folder.

`manifest.json` must be at the top level of that folder, which is how the zip is built.

**From this repo:** `chrome://extensions` → Developer mode → **Load unpacked** → pick the
repository root.

gitlab.com works immediately. For any other GitLab, open the extension's settings, add the
URL (including a path if it is installed under one, such as `https://example.com/gitlab`),
and approve the permission prompt for that site only.

## Use

Open **Merge requests** on a project or group. Drafts and labelled MRs disappear, and
**Hidden (n)** appears beside Open / Merged / Closed / All. Click it to see what was hidden
and why; click Open to go back.

- Hiding applies to **Open** and **All**. Merged and Closed are left exactly as GitLab drew
  them, and the Hidden tab is not offered there.
- Filters you apply in GitLab (`Labels`, `Author`, `Assignee`, `Milestone`, `Search`,
  `Scope`, `Draft`) are respected: the Hidden tab shows what is hidden within that view.
- Pause from the popup (or settings) when you want to see everything on one GitLab.

## "This page only"

The extension reads the list from GitLab with the session you are already signed in with.
When that request cannot answer — you are signed out, the session expired, the instance
refused the query — it keeps hiding what it can see on the current page and says so:

- Toolbar icon: outlined funnel with an amber base, count badge on grey.
- Popup: "This page only — signed out" or "This page only — GitLab didn't answer".
- Hidden tab: one line above the list, same wording.

No mode switch exists. The full list is used whenever it is available.

## No token, by design

An earlier design used a `read_api` personal access token. It was dropped: Chrome gives
extensions no keychain, so a token would sit in the browser profile in plain text, and the
extension does not need one.

Instead the content script posts a read-only GraphQL `query` to your GitLab, same-origin,
with the page's own session cookie and the page's `X-CSRF-Token` header. It can read exactly
what the page can read and has no code path that can create, change, merge or approve
anything. Nothing is stored beyond your labels, hosts and pauses, which never leave the
browser.

## Toolbar icon

| Icon | Meaning |
| --- | --- |
| Filled funnel, indigo, count badge | Full list — the session query answered |
| Outlined funnel, amber base, count badge | This page only — signed out or no answer |
| Funnel with a slash | Paused on this GitLab |
| Dashed funnel | Not a merge request list, or this GitLab is not enabled |

Shape carries the state (so it survives greyscale), the badge carries the count.

## Self-hosted GitLab

Add the base URL in settings. A path is part of the base URL: for an instance at
`https://example.com/gitlab`, add exactly that, and the extension asks for
`https://example.com/gitlab/*`. A wrong path fails visibly ("GitLab didn't answer") instead
of looking like a permissions problem.

## Configure a team default

**Export JSON** writes `{ "version": 1, "hideDrafts": true, "labels": [...] }`. Commit it or
share it, and teammates use **Import JSON**. Hosts and pauses are deliberately not exported:
they are per-machine.

## Develop

```bash
npm ci        # dev dependency: linkedom, for the DOM tests only
npm test      # node --test tests/
npm run package   # dist/gitlab-draft-hider.zip
```

The extension itself has no build step and no runtime dependencies: classic scripts loaded
in order by the manifest, plus a service worker.

Layout:

```
manifest.json
src/lib/        classify, hosts, config, graphql, dom, reconcile, iconState
src/content/    the orchestrator and its stylesheet
src/background/ service worker (settings, icon, host grants) + its tested core
src/options/    settings page
src/popup/      status strip
icons/          PNGs generated from assets/icons/*.svg by tools/make-icons.sh
```

CI (`.github/workflows/ci.yml`) runs the tests on every push and pull request, packages the
extension on `main`, uploads it as a build artifact, and attaches the same zip to a GitHub
release when a `v*` tag is pushed.

## Manual check before a release

- Project list, group list, subgroup list; signed in and signed out.
- Draft on page 2 of a large list is hidden and listed on page 1.
- Open count equals GitLab's minus the hidden open MRs; unknown filter leaves it alone.
- Filtered list (`label_name[]`, `author_username`, `scope`) matches the Hidden tab.
- Merged and Closed tabs untouched; All hides the same open rows.
- Pause/resume, enable a second host, deny the permission prompt.
- Light and dark theme; keyboard: tab to **Hidden**, Enter opens it, Enter closes it.
- Reload and in-app navigation do not leave duplicate tabs or stale marks.
- Self-hosted instance under a path.

## Troubleshooting

- **Nothing hides.** Check the icon: dashed means this GitLab is not enabled, slashed means
  paused, outlined amber means the session query failed.
- **"This page only".** Sign in to GitLab and reload, or the instance is refusing GraphQL.
  Hiding still works for the rows on screen.
- **Counts look odd with a filter.** If the URL carries a filter the extension does not
  understand, it says so and leaves the count alone.
- **GitLab changed its markup.** Hiding degrades to nothing rather than breaking the page;
  update `src/lib/dom.js`'s selectors. The GraphQL queries live in `src/lib/graphql.js`.
