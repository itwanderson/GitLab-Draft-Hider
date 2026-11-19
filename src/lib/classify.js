// Shared classifier. Classic script: content scripts cannot use ES modules and
// the extension ships no build step, so the module assigns itself to globalThis.
(function (root) {
  'use strict';

  // GitLab's draft prefixes: "Draft:", "[Draft]", "(Draft)" and the legacy WIP
  // spellings, ignoring case and leading whitespace. Deliberately anchored at the
  // start and requiring the separator, so "Drafting the plan" is not a draft.
  var DRAFT_PREFIX = /^\s*(\[draft\]|\(draft\)|draft:|wip:|\[wip\]|\(wip\))/i;

  function isDraftTitle(title) {
    return typeof title === 'string' && DRAFT_PREFIX.test(title);
  }

  function normalizeLabel(value) {
    return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function matchLabels(mrLabels, configured) {
    var wanted = new Set();
    var list = configured || [];
    for (var i = 0; i < list.length; i++) {
      var key = normalizeLabel(list[i]);
      if (key) wanted.add(key);
    }
    var out = [];
    var labels = mrLabels || [];
    for (var j = 0; j < labels.length; j++) {
      if (wanted.has(normalizeLabel(labels[j]))) out.push(labels[j]);
    }
    return out;
  }

  function classify(entry, options) {
    var reasons = [];
    var opts = options || {};
    var mr = entry || {};
    if (opts.hideDrafts && mr.draft) reasons.push('draft');
    // Configured order, MR's spelling: "label:dependencies" even when GitLab
    // returns it as "Dependencies".
    var configured = opts.labels || [];
    var labels = mr.labels || [];
    for (var i = 0; i < configured.length; i++) {
      var key = normalizeLabel(configured[i]);
      if (!key) continue;
      for (var j = 0; j < labels.length; j++) {
        if (normalizeLabel(labels[j]) === key) {
          reasons.push('label:' + labels[j]);
          break;
        }
      }
    }
    var seen = new Set();
    var unique = [];
    for (var k = 0; k < reasons.length; k++) {
      if (!seen.has(reasons[k])) {
        seen.add(reasons[k]);
        unique.push(reasons[k]);
      }
    }
    return { hidden: unique.length > 0, reasons: unique };
  }

  root.GDHClassify = {
    isDraftTitle: isDraftTitle,
    normalizeLabel: normalizeLabel,
    matchLabels: matchLabels,
    classify: classify,
  };
})(globalThis);
