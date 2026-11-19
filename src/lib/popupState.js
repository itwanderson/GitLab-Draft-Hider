// Popup decisions as a pure function, so the states are testable without a
// browser. The popup itself only reads chrome.* and renders this.
(function (root) {
  'use strict';

  function parse(url) {
    try {
      return new URL(String(url));
    } catch (e) {
      return null;
    }
  }

  // Longest configured host URL that prefixes this page, else the origin.
  // For a host that has not been granted yet we cannot know about an install
  // subpath, so the origin is the honest scope to request.
  function hostKeyFor(url, config) {
    var parsed = parse(url);
    if (!parsed) return '';
    var hosts = (config && config.hosts) || [];
    var best = '';
    for (var i = 0; i < hosts.length; i++) {
      var value = hosts[i] && hosts[i].url;
      if (typeof value !== 'string') continue;
      var prefix = value.replace(/\/+$/, '');
      if (parsed.href === prefix || parsed.href.indexOf(prefix + '/') === 0) {
        if (prefix.length > best.length) best = prefix;
      }
    }
    if (best) return best;
    return parsed.origin;
  }

  function statusFor(state) {
    if (state.state === 'full') return 'Full list — ' + (state.hiddenCount || 0) + ' hidden';
    if (state.state === 'paused') return 'Paused on this GitLab';
    if (state.state === 'page') {
      return state.reason === 'error'
        ? "This page only — GitLab didn't answer"
        : 'This page only — signed out';
    }
    return 'Open a Merge requests list';
  }

  function model(input) {
    var config = (input && input.config) || { hosts: [] };
    var state = (input && input.tabState) || { state: 'idle' };
    var key = hostKeyFor(input && input.tabUrl, config);
    var enabled = !!key && (key === 'https://gitlab.com' ||
      (config.hosts || []).some(function (host) { return host.url === key; }));
    var onList = state.state !== 'idle';

    return {
      status: statusFor(state),
      host: key,
      hostKey: key,
      showPause: onList,
      pauseLabel: state.state === 'paused' ? 'Resume here' : 'Pause here',
      showEnable: !!(input && input.isGitLab) && !!key && !enabled,
      enablePattern: key ? key + '/*' : '',
    };
  }

  root.GDHPopup = { model: model, hostKeyFor: hostKeyFor, statusFor: statusFor };
})(globalThis);
