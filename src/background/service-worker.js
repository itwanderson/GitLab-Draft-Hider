'use strict';

// Thin chrome.* wiring around serviceWorkerCore.js. Keep this file free of
// logic: everything worth testing lives in the core.
importScripts(
  '/src/lib/hosts.js',
  '/src/lib/config.js',
  '/src/lib/iconState.js',
  '/src/background/serviceWorkerCore.js'
);

const handlers = GDHServiceWorker.createHandlers({
  action: chrome.action,
  tabs: chrome.tabs,
  permissions: chrome.permissions,
  scripting: chrome.scripting,
  runtime: chrome.runtime,
  area: chrome.storage.local,
  session: chrome.storage.session,
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  handlers.onMessage(msg, sender).then(reply, (error) => reply({ ok: false, error: String(error) }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') handlers.onUpdated(tabId, changeInfo);
});

chrome.permissions.onRemoved.addListener((removed) => {
  handlers.onRemoved(removed);
});
