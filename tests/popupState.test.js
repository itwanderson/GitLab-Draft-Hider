import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGlobal } from './helpers/load.js';

const P = loadGlobal('popupState.js', 'GDHPopup');
const cfg = (hosts = []) => ({ hosts, pausedHosts: [] });

test('offers Enable on an ungranted GitLab, from the URL alone', () => {
  const m = P.model({
    tabUrl: 'https://example.com/gitlab/team/proj/-/merge_requests',
    config: cfg(),
    tabState: { state: 'idle' },
    isGitLab: true,
  });
  assert.equal(m.showEnable, true);
  assert.equal(m.hostKey, 'https://example.com');
  assert.equal(m.enablePattern, 'https://example.com/*');
  assert.equal(m.status, 'Open a Merge requests list');
});

test('does not offer Enable on gitlab.com or an enabled host', () => {
  assert.equal(P.model({
    tabUrl: 'https://gitlab.com/g/p/-/merge_requests', config: cfg(), tabState: { state: 'idle' }, isGitLab: true,
  }).showEnable, false);
  assert.equal(P.model({
    tabUrl: 'https://example.com/gitlab/g/p/-/merge_requests',
    config: cfg([{ url: 'https://example.com/gitlab', id: 'x' }]),
    tabState: { state: 'idle' }, isGitLab: true,
  }).showEnable, false);
});

test('does not offer Enable for a page that is not GitLab', () => {
  assert.equal(P.model({
    tabUrl: 'https://example.com', config: cfg(), tabState: { state: 'idle' }, isGitLab: false,
  }).showEnable, false);
});

test('pause label follows the state, and idle hides it', () => {
  const base = { tabUrl: 'https://gitlab.com/g/p/-/merge_requests', config: cfg(), isGitLab: true };
  assert.equal(P.model({ ...base, tabState: { state: 'full', hiddenCount: 5 } }).pauseLabel, 'Pause here');
  assert.equal(P.model({ ...base, tabState: { state: 'paused' } }).pauseLabel, 'Resume here');
  assert.equal(P.model({ ...base, tabState: { state: 'idle' } }).showPause, false);
});

test('status copy covers every state', () => {
  const base = { tabUrl: 'https://gitlab.com/g/p/-/merge_requests', config: cfg(), isGitLab: true };
  assert.equal(P.model({ ...base, tabState: { state: 'full', hiddenCount: 5 } }).status, 'Full list — 5 hidden');
  assert.equal(P.model({ ...base, tabState: { state: 'page', reason: 'signed-out' } }).status, 'This page only — signed out');
  assert.equal(P.model({ ...base, tabState: { state: 'page', reason: 'error' } }).status, "This page only — GitLab didn't answer");
  assert.equal(P.model({ ...base, tabState: { state: 'paused' } }).status, 'Paused on this GitLab');
});
