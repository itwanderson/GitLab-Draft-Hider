import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('packages the extension with manifest.json at the zip root', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'gdh-')), 'ext.zip');
  execFileSync('bash', ['scripts/package.sh', out], { stdio: 'pipe' });
  const listing = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(listing.includes('manifest.json'));
  assert.ok(listing.some((f) => f.startsWith('src/content/content.js')));
  assert.ok(listing.some((f) => f.startsWith('icons/')));
  assert.ok(!listing.some((f) => f.startsWith('tests/') || f.startsWith('docs/') || f.startsWith('node_modules/')));
});

test('the workflow tests, packages, and attaches a release asset on tags', () => {
  const yml = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(yml, /npm ci/);
  assert.match(yml, /npm test/);
  assert.match(yml, /actions\/upload-artifact@v4/);
  assert.match(yml, /softprops\/action-gh-release@v2/);
  assert.match(yml, /permissions:\s*\n\s*contents:\s*write/);
  assert.match(yml, /tags:\s*\n\s*-\s*'?v\*'?/);
});
