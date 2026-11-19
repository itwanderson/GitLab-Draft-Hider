import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * Load a classic-script library from src/lib the way the page loads it: as a
 * plain script that assigns itself to globalThis. The extension ships no build
 * step and content scripts cannot use ES modules, so this is the real contract.
 *
 * vm.runInThisContext (not a fresh context) keeps arrays and objects in the
 * test's realm, so assert.deepEqual compares values rather than prototypes.
 * Each test file runs in its own process, so the globals stay contained.
 */
export function loadGlobal(file, key) {
  const path = new URL(`../../src/lib/${file}`, import.meta.url);
  vm.runInThisContext(readFileSync(path, 'utf8'), { filename: path.pathname });
  const value = globalThis[key];
  if (!value) throw new Error(`src/lib/${file} did not define ${key}`);
  return value;
}
