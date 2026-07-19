#!/usr/bin/env node
// Zero-dependency security/policy audit. Scans only runtime code
// (manifest.json, service-worker.js, offscreen/, popup/, options/,
// shared/) - tests/, README.md, SECURITY.md, and LICENSE are intentionally
// excluded so example URLs there never produce a false positive. Exits
// non-zero if any hard check fails.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RUNTIME_ROOTS = ['manifest.json', 'service-worker.js', 'offscreen', 'popup', 'options', 'shared'];
const RUNTIME_EXTENSIONS = new Set(['.js', '.html', '.css', '.json']);

function walk(relPath) {
  const abs = path.join(ROOT, relPath);
  if (!existsSync(abs)) return [];
  const stat = statSync(abs);
  if (stat.isFile()) {
    return RUNTIME_EXTENSIONS.has(path.extname(abs)) ? [relPath] : [];
  }
  const results = [];
  for (const entry of readdirSync(abs)) {
    results.push(...walk(path.join(relPath, entry)));
  }
  return results;
}

const runtimeFiles = RUNTIME_ROOTS.flatMap(walk);
const runtimeContents = new Map(runtimeFiles.map((f) => [f, readFileSync(path.join(ROOT, f), 'utf8')]));
const runtimeJsEntries = [...runtimeContents.entries()].filter(([f]) => f.endsWith('.js'));

const violations = [];
const advisories = [];

function fail(check, detail) {
  violations.push(`[FAIL] ${check}: ${detail}`);
}

function warn(check, detail) {
  advisories.push(`[ADVISORY] ${check}: ${detail}`);
}

// 1. Manifest permissions ---------------------------------------------------
const manifest = JSON.parse(runtimeContents.get('manifest.json') ?? '{}');
const expectedPermissions = ['activeTab', 'tabCapture', 'offscreen', 'storage', 'webNavigation'];
const actualPermissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
const permissionsMatch =
  actualPermissions.length === expectedPermissions.length &&
  expectedPermissions.every((p) => actualPermissions.includes(p));
if (!permissionsMatch) {
  fail(
    'manifest-permissions',
    `permissions must be exactly ${JSON.stringify(expectedPermissions)}, found ${JSON.stringify(actualPermissions)}`
  );
}

const forbiddenManifestKeys = ['host_permissions', 'optional_host_permissions', 'content_scripts', 'externally_connectable'];
for (const key of forbiddenManifestKeys) {
  if (key in manifest) fail('manifest-forbidden-key', `manifest.json must not contain "${key}"`);
}
if ('web_accessible_resources' in manifest) {
  fail('manifest-web-accessible-resources', 'web_accessible_resources is present but not concretely justified in this project');
}

// 2. package.json / dependency hygiene --------------------------------------
const packageJsonPath = path.join(ROOT, 'package.json');
if (existsSync(packageJsonPath)) {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  for (const field of ['dependencies', 'devDependencies']) {
    if (pkg[field] && Object.keys(pkg[field]).length > 0) {
      fail('package-json-dependencies', `package.json "${field}" must be empty or absent`);
    }
  }
} else {
  fail('package-json-missing', 'package.json is required');
}

if (existsSync(path.join(ROOT, 'node_modules'))) {
  fail('node-modules-present', 'node_modules must not exist');
}

for (const lockfile of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']) {
  if (existsSync(path.join(ROOT, lockfile))) {
    fail('lockfile-present', `${lockfile} must not exist`);
  }
}

// 3. Forbidden runtime API usage ---------------------------------------------
const FORBIDDEN_CALLS = ['fetch(', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon', 'eval(', 'new Function(', 'WebAssembly'];
for (const [file, content] of runtimeJsEntries) {
  for (const token of FORBIDDEN_CALLS) {
    if (content.includes(token)) fail('forbidden-runtime-api', `${file} contains "${token}"`);
  }
}

// 4. External references -----------------------------------------------------
const EXTERNAL_SRC_PATTERNS = [
  /<script[^>]+src=["']https?:/i,
  /<link[^>]+href=["']https?:/i,
  /<img[^>]+src=["']https?:/i,
  /<iframe[^>]+src=["']https?:/i,
];
for (const [file, content] of runtimeContents) {
  if (!file.endsWith('.html')) continue;
  for (const pattern of EXTERNAL_SRC_PATTERNS) {
    if (pattern.test(content)) fail('external-reference', `${file} references an external http(s) resource`);
  }
}
for (const [file, content] of runtimeJsEntries) {
  if (/import\s+.*from\s+['"]https?:/.test(content) || /import\(\s*['"]https?:/.test(content)) {
    fail('remote-import', `${file} contains a remote import`);
  }
}

// 5. Minification heuristic (advisory only) -----------------------------------
const LINE_LENGTH_THRESHOLD = 400;
for (const [file, content] of runtimeJsEntries) {
  if (content.split('\n').some((line) => line.length > LINE_LENGTH_THRESHOLD)) {
    warn('possible-minification', `${file} contains a line longer than ${LINE_LENGTH_THRESHOLD} characters (heuristic only)`);
  }
}

// 6. Single canonical matcher --------------------------------------------------
for (const [file, content] of runtimeJsEntries) {
  const definesCanonicalizer = /export function canonicalizePageKey/.test(content) || /export function isRestrictedPageUrl/.test(content);
  if (definesCanonicalizer && file !== 'shared/urls.js') {
    fail('duplicate-matcher-definition', `${file} defines page-matching logic outside shared/urls.js`);
  }
  if (file !== 'shared/urls.js' && /wildcard|RegExp\(/i.test(content)) {
    fail('unexpected-matching-logic', `${file} appears to contain matching logic outside shared/urls.js`);
  }
}

// 7. No polling residue ---------------------------------------------------------
for (const [file, content] of runtimeJsEntries) {
  if (/VERIFY_SESSIONS/.test(content)) fail('polling-residue', `${file} references VERIFY_SESSIONS`);
  if (/setInterval\s*\(/.test(content)) fail('polling-residue', `${file} contains setInterval`);
  if (/chrome\.alarms/.test(content)) fail('polling-residue', `${file} references chrome.alarms`);
}

// 8. No compressor / limiter / AGC ------------------------------------------------
const FORBIDDEN_AUDIO_TOKENS = ['DynamicsCompressorNode', 'WaveShaperNode', 'AudioWorklet'];
for (const [file, content] of runtimeJsEntries) {
  for (const token of FORBIDDEN_AUDIO_TOKENS) {
    if (content.includes(token)) fail('forbidden-audio-processing', `${file} contains "${token}"`);
  }
}

// 9. Storage-write containment ----------------------------------------------------
for (const [file, content] of runtimeJsEntries) {
  if (/chrome\.storage\.local\.set\(/.test(content) && file !== 'shared/settings.js') {
    fail('storage-write-outside-settings', `${file} calls chrome.storage.local.set directly`);
  }
  if (/chrome\.storage\.sync|chrome\.storage\.managed/.test(content)) {
    fail('unexpected-storage-area', `${file} references chrome.storage.sync or chrome.storage.managed`);
  }
}

// 10. Non-async onMessage listeners --------------------------------------------
for (const [file, content] of runtimeJsEntries) {
  if (/onMessage\.addListener\(\s*async/.test(content)) {
    fail('async-message-listener', `${file} declares an onMessage listener as async`);
  }
}

// 11. Structural markers ----------------------------------------------------------
const offscreenContent = runtimeContents.get('offscreen/offscreen.js') ?? '';
const swContent = runtimeContents.get('service-worker.js') ?? '';

if (!offscreenContent.includes('pageKey') || !offscreenContent.includes('operationId')) {
  fail('offscreen-session-shape', 'offscreen/offscreen.js must reference both pageKey and operationId');
}
if (!offscreenContent.includes('USER_MEDIA') && !swContent.includes('USER_MEDIA')) {
  fail('offscreen-creation-reason', 'USER_MEDIA reason string not found in offscreen-creation code');
}
if (!offscreenContent.includes('getTracks(')) {
  fail('teardown-tracks', 'offscreen/offscreen.js teardown must iterate mediaStream.getTracks()');
}

// 'confirmedStopCapture' replaces the former 'allowlistRevision' marker:
// the revision counter became dead code once the allowlist-membership gate
// was removed from START_CAPTURE, whereas confirmedStopCapture is the
// central primitive of the fail-closed teardown/reconciliation guarantee
// and is a far more meaningful structural marker to assert is still present.
for (const marker of ['ensureReconciled', 'emergencyFailClosed', 'webNavigation.getFrame', 'confirmedStopCapture', 'tabCapture.onStatusChanged']) {
  if (!swContent.includes(marker)) {
    fail('service-worker-missing-marker', `service-worker.js does not appear to contain "${marker}"`);
  }
}

// Heuristic only - true top-level placement is confirmed by manual review.
if (!/^chrome\.tabCapture\.onStatusChanged\.addListener/m.test(swContent)) {
  warn(
    'top-level-listener-placement',
    'chrome.tabCapture.onStatusChanged.addListener was not found at column 0 - confirm manually that it is registered at module top level, not nested inside a function'
  );
}

// 12. Advisory: possible full-URL logging -----------------------------------------
for (const [file, content] of runtimeJsEntries) {
  content.split('\n').forEach((line, index) => {
    if (/console\.(log|error|warn)\s*\([^)]*\b(pageKey|tabUrl|rawUrl)\b/.test(line)) {
      warn('possible-url-logging', `${file}:${index + 1} may log a page URL directly (heuristic only)`);
    }
  });
}

// 13. Icons exist locally -----------------------------------------------------------
for (const icon of ['icon16.png', 'icon32.png', 'icon48.png', 'icon128.png']) {
  if (!existsSync(path.join(ROOT, 'icons', icon))) {
    fail('missing-icon', `icons/${icon} is missing`);
  }
}

// ---------------------------------------------------------------------------------
console.log(`Scanned ${runtimeFiles.length} runtime files (manifest.json, service-worker.js, offscreen/, popup/, options/, shared/).`);
console.log('tests/, README.md, SECURITY.md, and LICENSE are intentionally excluded from pattern scanning.\n');

if (advisories.length > 0) {
  console.log('Advisory findings (not hard failures - review manually):');
  for (const line of advisories) console.log('  ' + line);
  console.log('');
}

if (violations.length > 0) {
  console.log('Hard failures:');
  for (const line of violations) console.log('  ' + line);
  console.log('');
  console.log(`FAILED: ${violations.length} violation(s) found.`);
  process.exit(1);
} else {
  console.log('PASSED: no hard violations found.');
  process.exit(0);
}
