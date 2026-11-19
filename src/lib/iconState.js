// Toolbar icon state: shape carries the source, badge carries the count.
// Classic script for the service worker (importScripts) and tests.
(function (root) {
  'use strict';

  function badgeText(count) {
    var n = Number(count) || 0;
    if (n <= 0) return '';
    if (n > 99) return '99+';
    return String(n);
  }

  function stateFor(input) {
    var state = (input && input.state) || 'idle';
    var count = (input && input.hiddenCount) || 0;
    var reason = (input && input.reason) || 'signed-out';
    var badge = '';
    var title;

    if (state === 'paused') {
      title = 'GitLab Draft Hider — paused on this GitLab';
    } else if (state === 'idle') {
      title = 'GitLab Draft Hider — open a Merge requests list';
    } else if (state === 'page') {
      badge = badgeText(count);
      title = 'GitLab Draft Hider — this page only: ' +
        (reason === 'error' ? "GitLab didn't answer" : 'signed out');
    } else {
      state = 'full';
      badge = badgeText(count);
      title = 'GitLab Draft Hider — full list, ' + (Number(count) || 0) + ' hidden';
    }

    return { state: state, badge: badge, title: title };
  }

  function assetPath(state, size) {
    if (size === 16 || size === 32) return 'icons/icon-' + size + '-' + state + '.png';
    return 'icons/icon-' + size + '.png';
  }

  function pathsFor(state) {
    return { 16: assetPath(state, 16), 32: assetPath(state, 32) };
  }

  root.GDHIcons = {
    stateFor: stateFor,
    badgeText: badgeText,
    assetPath: assetPath,
    pathsFor: pathsFor,
  };
})(globalThis);
