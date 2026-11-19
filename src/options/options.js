// Settings page. All state lives in the service worker; this page only renders
// what the worker returns and forwards intent. No credential is involved.
(function () {
  'use strict';

  var GDHHosts = globalThis.GDHHosts;
  var BUILTIN = { url: 'https://gitlab.com', id: 'gdh-https-gitlab-com', builtIn: true };
  var config = null;

  function $(id) {
    return document.getElementById(id);
  }

  function send(message) {
    return chrome.runtime.sendMessage(message).then(function (reply) {
      if (!reply || reply.ok === false) throw new Error((reply && reply.error) || 'request failed');
      return reply;
    });
  }

  function notice(text, tone) {
    var node = $('notice');
    node.textContent = text || '';
    node.hidden = !text;
    if (text) node.setAttribute('data-tone', tone || 'info');
    else node.removeAttribute('data-tone');
  }

  function hosts() {
    var out = [BUILTIN];
    var stored = config.hosts || [];
    for (var i = 0; i < stored.length; i++) out.push(stored[i]);
    return out;
  }

  function hostKey(host) {
    var base = GDHHosts.normalizeBaseUrl(host.url);
    return base ? base.origin + base.prefix : host.url;
  }

  function button(label, onClick) {
    var el = document.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.addEventListener('click', onClick);
    return el;
  }

  function chip(label) {
    var wrap = document.createElement('span');
    wrap.className = 'chip';
    var text = document.createElement('span');
    text.textContent = label;
    wrap.appendChild(text);
    wrap.appendChild(button('\u00d7', function () {
      send({ type: 'gdh:remove-label', name: label }).then(function (r) {
        config = r.config;
        render();
      }, fail);
    }));
    return wrap;
  }

  function renderLabels() {
    var box = $('labels');
    box.textContent = '';
    if (!config.labels.length) {
      var empty = document.createElement('p');
      empty.className = 'help';
      empty.textContent = 'No labels yet — nothing is hidden for a label until you add one.';
      box.appendChild(empty);
      return;
    }
    for (var i = 0; i < config.labels.length; i++) box.appendChild(chip(config.labels[i]));
  }

  function renderHosts() {
    var box = $('hosts');
    box.textContent = '';
    var list = hosts();
    for (var i = 0; i < list.length; i++) {
      (function (host) {
        var card = document.createElement('div');
        card.className = 'card';
        var left = document.createElement('div');
        var url = document.createElement('div');
        url.className = 'url';
        url.textContent = host.url;
        var meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = host.builtIn ? 'always enabled' : 'enabled';
        left.appendChild(url);
        left.appendChild(meta);
        card.appendChild(left);
        if (!host.builtIn) {
          card.appendChild(button('Remove', function () {
            removeHost(host);
          }));
        }
        box.appendChild(card);
      })(list[i]);
    }
  }

  function renderPause() {
    var box = $('pause');
    box.textContent = '';
    var list = hosts();
    for (var i = 0; i < list.length; i++) {
      (function (host) {
        var key = hostKey(host);
        var card = document.createElement('label');
        card.className = 'card';
        var left = document.createElement('div');
        var url = document.createElement('div');
        url.className = 'url';
        url.textContent = host.url;
        left.appendChild(url);
        card.appendChild(left);
        var box2 = document.createElement('input');
        box2.type = 'checkbox';
        box2.checked = config.pausedHosts.indexOf(key) !== -1;
        box2.setAttribute('aria-label', 'Pause on ' + host.url);
        box2.addEventListener('change', function () {
          send({ type: 'gdh:set-paused', hostKey: key, paused: box2.checked }).then(function (r) {
            config = r.config;
          }, fail);
        });
        card.appendChild(box2);
        box.appendChild(card);
      })(list[i]);
    }
  }

  function render() {
    $('hide-drafts').checked = !!config.hideDrafts;
    renderLabels();
    renderHosts();
    renderPause();
  }

  function fail(error) {
    notice(String(error && error.message ? error.message : error), 'error');
  }

  function addLabel() {
    var input = $('label-input');
    var name = input.value.trim();
    if (!name) return;
    send({ type: 'gdh:add-label', name: name }).then(function (r) {
      config = r.config;
      input.value = '';
      notice(null);
      render();
    }, fail);
  }

  function addHost() {
    var input = $('host-url');
    var base = GDHHosts.normalizeBaseUrl(input.value.trim());
    if (!base) {
      notice('That does not look like a GitLab URL. Include https:// and no query string.', 'error');
      return;
    }
    var origins = [GDHHosts.matchPattern(base)];
    chrome.permissions.request({ origins: origins }).then(function (granted) {
      if (!granted) {
        notice('Permission denied — this GitLab was not added.', 'error');
        return;
      }
      send({ type: 'gdh:add-host', url: base.origin + base.prefix }).then(function (r) {
        config = r.config;
        input.value = '';
        notice('Added ' + base.origin + base.prefix + '. Reload any open tab there.', 'info');
        render();
      }, fail);
    }, fail);
  }

  function removeHost(host) {
    var base = GDHHosts.normalizeBaseUrl(host.url);
    send({ type: 'gdh:forget-host', id: host.id }).then(function (r) {
      config = r.config;
      if (base && chrome.permissions && chrome.permissions.remove) {
        return chrome.permissions.remove({ origins: [GDHHosts.matchPattern(base)] });
      }
      return null;
    }).then(function () {
      notice('Removed ' + host.url + '.', 'info');
      render();
    }, fail);
  }

  function exportConfig() {
    send({ type: 'gdh:export-config' }).then(function (r) {
      var blob = new Blob([r.json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = 'gitlab-draft-hider.json';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      notice('Exported labels and toggles.', 'info');
    }, fail);
  }

  function importConfig(file) {
    var reader = new FileReader();
    reader.onload = function () {
      send({ type: 'gdh:import-config', json: String(reader.result) }).then(function (r) {
        config = r.config;
        render();
        notice('Imported labels and toggles.', 'info');
      }, function () {
        notice('That file is not a GitLab Draft Hider export.', 'error');
      });
    };
    reader.readAsText(file);
  }

  function init() {
    $('hide-drafts').addEventListener('change', function () {
      send({ type: 'gdh:set-config', patch: { hideDrafts: $('hide-drafts').checked } }).then(function (r) {
        config = r.config;
      }, fail);
    });
    $('add-label').addEventListener('click', addLabel);
    $('label-input').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        addLabel();
      }
    });
    var suggests = document.querySelectorAll('[data-suggestion]');
    for (var i = 0; i < suggests.length; i++) {
      suggests[i].addEventListener('click', function (event) {
        var name = event.currentTarget.getAttribute('data-suggestion');
        send({ type: 'gdh:add-label', name: name }).then(function (r) {
          config = r.config;
          render();
        }, fail);
      });
    }
    $('add-host').addEventListener('click', addHost);
    $('export').addEventListener('click', exportConfig);
    $('import-file').addEventListener('change', function (event) {
      var file = event.target.files && event.target.files[0];
      if (file) importConfig(file);
      event.target.value = '';
    });

    send({ type: 'gdh:get-config' }).then(function (r) {
      config = r.config;
      render();
    }, function (error) {
      notice('Settings could not load: ' + error.message, 'error');
    });
  }

  init();
})();
