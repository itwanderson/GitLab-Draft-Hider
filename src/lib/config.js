// Local configuration. Classic script: content scripts cannot use ES modules and
// the extension ships no build step, so the module assigns itself to globalThis.
// `area` is injected (chrome.storage.local in the extension, a plain object in
// tests) and must provide promise-returning get(key) and set(object).
(function (root) {
  'use strict';

  var KEY = 'gdh.config';
  var VERSION = 1;

  function defaults() {
    return { version: VERSION, hideDrafts: true, labels: [], hosts: [], pausedHosts: [] };
  }

  function isStringArray(value) {
    if (!Array.isArray(value)) return false;
    for (var i = 0; i < value.length; i++) if (typeof value[i] !== 'string') return false;
    return true;
  }

  function normalizeHosts(value) {
    var out = [];
    var seen = new Set();
    var list = Array.isArray(value) ? value : [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var base = root.GDHHosts.normalizeBaseUrl(item.url);
      if (!base) continue;
      var id = root.GDHHosts.registrationFor(base).id;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ url: base.origin + base.prefix, id: id });
    }
    return out;
  }

  function normalize(raw) {
    var base = defaults();
    var value = raw && typeof raw === 'object' ? raw : {};
    if (typeof value.hideDrafts === 'boolean') base.hideDrafts = value.hideDrafts;
    if (isStringArray(value.labels)) {
      base.labels = [];
      for (var i = 0; i < value.labels.length; i++) {
        var label = value.labels[i].trim();
        if (label) base.labels.push(label);
      }
    }
    base.hosts = normalizeHosts(value.hosts);
    if (isStringArray(value.pausedHosts)) base.pausedHosts = value.pausedHosts.slice();
    return base;
  }

  function createConfig(area) {
    async function read() {
      var stored = await area.get(KEY);
      return normalize(stored && stored[KEY]);
    }

    async function write(config) {
      var next = normalize(config);
      var patch = {};
      patch[KEY] = next;
      await area.set(patch);
      return next;
    }

    async function patch(partial) {
      var current = await read();
      var next = {
        version: VERSION,
        hideDrafts: typeof partial.hideDrafts === 'boolean' ? partial.hideDrafts : current.hideDrafts,
        labels: isStringArray(partial.labels) ? partial.labels : current.labels,
        hosts: current.hosts,
        pausedHosts: current.pausedHosts,
      };
      return write(next);
    }

    async function addLabel(name) {
      var label = String(name == null ? '' : name).trim();
      if (!label) return read();
      var current = await read();
      var key = label.toLowerCase();
      for (var i = 0; i < current.labels.length; i++) {
        if (current.labels[i].toLowerCase() === key) return current;
      }
      current.labels.push(label);
      return write(current);
    }

    async function removeLabel(name) {
      var key = String(name == null ? '' : name).trim().toLowerCase();
      var current = await read();
      current.labels = current.labels.filter(function (label) {
        return label.toLowerCase() !== key;
      });
      return write(current);
    }

    async function addHost(input) {
      var base = root.GDHHosts.normalizeBaseUrl(input);
      if (!base) return read();
      var current = await read();
      var id = root.GDHHosts.registrationFor(base).id;
      for (var i = 0; i < current.hosts.length; i++) {
        if (current.hosts[i].id === id) return current;
      }
      current.hosts.push({ url: base.origin + base.prefix, id: id });
      return write(current);
    }

    async function removeHost(id) {
      var current = await read();
      current.hosts = current.hosts.filter(function (host) {
        return host.id !== id;
      });
      return write(current);
    }

    async function setPaused(hostKey, paused) {
      var current = await read();
      var has = current.pausedHosts.indexOf(hostKey) !== -1;
      if (paused && !has) current.pausedHosts.push(hostKey);
      if (!paused && has) {
        current.pausedHosts = current.pausedHosts.filter(function (key) {
          return key !== hostKey;
        });
      }
      return write(current);
    }

    async function isPaused(hostKey) {
      var current = await read();
      return current.pausedHosts.indexOf(hostKey) !== -1;
    }

    async function exportJson() {
      var current = await read();
      return JSON.stringify({ version: VERSION, hideDrafts: current.hideDrafts, labels: current.labels });
    }

    async function importJson(text) {
      var parsed;
      try {
        parsed = JSON.parse(String(text));
      } catch (e) {
        throw new Error('invalid config');
      }
      if (!parsed || parsed.version !== VERSION || typeof parsed.hideDrafts !== 'boolean' || !isStringArray(parsed.labels)) {
        throw new Error('invalid config');
      }
      var current = await read();
      current.hideDrafts = parsed.hideDrafts;
      current.labels = parsed.labels.slice(0, 100).map(function (label) {
        return String(label).slice(0, 200).trim();
      }).filter(Boolean);
      return write(current);
    }

    return {
      read: read,
      patch: patch,
      addLabel: addLabel,
      removeLabel: removeLabel,
      addHost: addHost,
      removeHost: removeHost,
      setPaused: setPaused,
      isPaused: isPaused,
      exportJson: exportJson,
      importJson: importJson,
    };
  }

  root.GDHConfig = { DEFAULT_CONFIG: defaults(), createConfig: createConfig };
})(globalThis);
