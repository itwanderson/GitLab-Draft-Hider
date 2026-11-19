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
