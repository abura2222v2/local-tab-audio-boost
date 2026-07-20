#!/usr/bin/env node
// Zero-dependency security/policy audit. Scans only runtime code
// (manifest.json, service-worker.js, offscreen/, popup/, options/,
// shared/) - tests/, README.md, SECURITY.md, and LICENSE are intentionally
// excluded so example URLs there never produce a false positive. Exits
// non-zero if any hard check fails.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RUNTIME_ROOTS = ['manifest.json', 'service-worker.js', 'offscreen', 'popup', 'options', 'shared', 'page-audio'];
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
// `scripting` is required by the fullscreen-compatible page-audio backend,
// which injects its packaged controller only after an explicit user action.
const expectedPermissions = ['activeTab', 'tabCapture', 'offscreen', 'storage', 'webNavigation', 'scripting'];
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

// 14. Schema 6 -----------------------------------------------------------------------
// The saved-page storage model must be schema 6, and its runtime record shape
// must carry exactly the three documented fields.
const constantsContent = runtimeContents.get('shared/constants.js') ?? '';
if (!/export const SCHEMA_VERSION\s*=\s*6\b/.test(constantsContent)) {
  fail('schema-version', 'shared/constants.js must declare SCHEMA_VERSION = 6');
}
const metadataContent = runtimeContents.get('shared/saved-page-metadata.js') ?? '';
if (!metadataContent) {
  fail('missing-metadata-module', 'shared/saved-page-metadata.js is required for the schema-6 record shape');
}
for (const field of ['volumePercent', 'titleSnapshot', 'customName']) {
  if (!metadataContent.includes(field)) {
    fail('saved-page-record-shape', `shared/saved-page-metadata.js does not define the "${field}" record field`);
  }
}

/**
 * Strips block and line comments so a token check tests actual CODE, not prose.
 * The doc comments in this project deliberately NAME the things they promise
 * never to do ("never loads a favicon", "never calls chrome.storage.local
 * directly"), so scanning raw text would flag exactly the files that document
 * the guarantee best.
 */
function stripJsComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');
}
const runtimeJsCode = runtimeJsEntries.map(([file, content]) => [file, stripJsComments(content)]);

// 15. No remote title / favicon / metadata lookup -------------------------------------
// The display name for a saved page is derived ONLY from locally stored text.
// Nothing may reach out for a title, a favicon, or any page metadata.
const REMOTE_METADATA_TOKENS = [
  'favicon',
  'chrome://favicon',
  '_favicon',
  'opengraph',
  'og:title',
  'oembed',
  'jsonp',
  'importScripts(',
];
for (const [file, content] of runtimeJsCode) {
  for (const token of REMOTE_METADATA_TOKENS) {
    if (content.toLowerCase().includes(token.toLowerCase())) {
      fail('remote-metadata-lookup', `${file} references "${token}" - saved-page labels must be derived locally`);
    }
  }
}

// 16. Storage-write containment, including remove() ------------------------------------
// Only shared/settings.js may mutate chrome.storage.local at all - the popup
// and options page must never write or delete storage directly.
for (const [file, content] of runtimeJsCode) {
  if (/chrome\.storage\.local\.remove\(/.test(content) && file !== 'shared/settings.js') {
    fail('storage-remove-outside-settings', `${file} calls chrome.storage.local.remove directly`);
  }
  if (file.startsWith('options/') || file.startsWith('popup/')) {
    if (/chrome\.storage\b/.test(content)) {
      fail('ui-storage-access', `${file} touches chrome.storage directly - every write must go through the service worker`);
    }
  }
}

// 17. Selection / search state is never persisted ---------------------------------------
// Selection and the search query are temporary view state. Neither may appear
// as a storage key, nor in the persisted saved-page record shape.
const settingsContent = runtimeContents.get('shared/settings.js') ?? '';
const PERSISTENCE_FORBIDDEN_STATE = ['selection', 'selectedPageKeys', 'searchQuery', 'searchTerm'];
for (const token of PERSISTENCE_FORBIDDEN_STATE) {
  if (settingsContent.includes(token)) {
    fail('persisted-view-state', `shared/settings.js references "${token}" - selection/search state must never be persisted`);
  }
  if (constantsContent.includes(`${token}:`)) {
    fail('persisted-view-state', `shared/constants.js declares a storage key for "${token}"`);
  }
}

// 18. Every new message type has target-specific validation + a sender rule --------------
// A message type that the service worker handles must appear both in
// shared/validation.js (a payload validator keyed by target) and in
// service-worker.js's explicit allowed-sender matrix.
const validationContent = runtimeContents.get('shared/validation.js') ?? '';
const SW_HANDLED_MESSAGE_TYPES = [
  'RENAME_SAVED_PAGE',
  'RESET_SELECTED_SAVED_PAGES_TO_100',
  'DELETE_SELECTED_SAVED_PAGES',
  'SET_SAVED_PAGE_LIVE_GAIN',
  'UPDATE_SAVED_PAGE_VOLUME',
];
for (const type of SW_HANDLED_MESSAGE_TYPES) {
  if (!validationContent.includes(`MESSAGE_TYPES.${type}`)) {
    fail('missing-payload-validator', `shared/validation.js has no target-keyed payload validator for ${type}`);
  }
  if (!new RegExp(`OPTIONS_ONLY_MESSAGE_TYPES[\\s\\S]*MESSAGE_TYPES\\.${type}`).test(swContent)) {
    fail('missing-sender-rule', `service-worker.js does not list ${type} in its allowed-sender matrix`);
  }
}

// 19. Fullscreen integrity + page-audio injection safety ---------------------------
// The whole point of the page-audio backend is that the page's OWN fullscreen
// keeps working. That requires the extension to stay entirely out of the
// fullscreen path, and to never hold a tab-capture stream while it is active.
{
  const stripComments = (source) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => {
        const index = line.indexOf('//');
        return index === -1 ? line : line.slice(0, index);
      })
      .join('\n');

  // No fullscreen interception, patching, or synthetic key injection anywhere.
  const FULLSCREEN_FORBIDDEN = [
    'requestFullscreen',
    'webkitRequestFullscreen',
    'mozRequestFullScreen',
    'exitFullscreen',
    'new KeyboardEvent',
    'initKeyboardEvent',
    'keyCode: 122',
    "key: 'F11'",
    'key:"F11"',
  ];
  for (const [file, content] of runtimeJsEntries) {
    const code = stripComments(content);
    for (const token of FULLSCREEN_FORBIDDEN) {
      if (code.includes(token)) {
        fail('fullscreen-interference', `${file} references "${token}" - the extension must stay out of the fullscreen path`);
      }
    }
  }

  // The MAIN-world page controller must hold no extension privilege at all,
  // and must never reach for capture.
  const controllerFile = 'page-audio/page-audio-controller.js';
  const controllerCode = stripComments(runtimeContents.get(controllerFile) ?? '');
  if (!controllerCode) {
    fail('missing-page-controller', `${controllerFile} is required by the page-audio backend`);
  }
  for (const token of ['chrome.tabCapture', 'chrome.storage', 'chrome.offscreen', 'chrome.scripting', 'getUserMedia', 'MediaRecorder']) {
    if (controllerCode.includes(token)) {
      fail('page-controller-privilege', `${controllerFile} must not reference ${token}`);
    }
  }
  // It must not touch the player's controls, layout, or element volume.
  for (const token of ['preventDefault', 'stopPropagation', 'innerHTML', 'appendChild', 'replaceChild']) {
    if (controllerCode.includes(token)) {
      fail('page-controller-dom-interference', `${controllerFile} must not use ${token}`);
    }
  }
  if (/\.volume\s*=/.test(controllerCode) || /\.muted\s*=/.test(controllerCode)) {
    fail('page-controller-dom-interference', `${controllerFile} must not change element volume/muted`);
  }

  // Injection must use packaged local files - never a code string or a
  // serialized function.
  const swCode = stripComments(runtimeContents.get('service-worker.js') ?? '');
  if (swCode.includes('executeScript')) {
    if (!/files:\s*\[/.test(swCode)) {
      fail('injection-not-packaged', 'chrome.scripting.executeScript must inject packaged files');
    }
    if (/executeScript\([^)]*\bcode\s*:/.test(swCode) || /executeScript\([^)]*\bfunc\s*:/.test(swCode)) {
      fail('injection-not-packaged', 'chrome.scripting.executeScript must not inject a code string or serialized function');
    }
  }

  // The page-audio start path must never call tabCapture. Checked structurally:
  // the page-audio activation helpers and the tabCapture call sites must not
  // appear in the same function body.
  const pageAudioStart = (swCode.match(/async function activatePageAudio[\s\S]*?\n\}/) || [''])[0];
  if (pageAudioStart && /chrome\.tabCapture/.test(pageAudioStart)) {
    fail('page-audio-uses-capture', 'the page-audio activation path must never call chrome.tabCapture');
  }
  const pageAudioHandler = (swCode.match(/async function handleStartPageAudio[\s\S]*?\n\}/) || [''])[0];
  if (pageAudioHandler && /chrome\.tabCapture|ensureOffscreenDocument/.test(pageAudioHandler)) {
    fail('page-audio-uses-capture', 'handleStartPageAudio must never call tabCapture or create an offscreen document');
  }

  // Compatibility mode must remain a distinct, explicitly-requested message.
  const constantsCode = runtimeContents.get('shared/constants.js') ?? '';
  if (!constantsCode.includes('START_PAGE_AUDIO')) {
    fail('missing-page-audio-message', 'START_PAGE_AUDIO must exist as its own message type');
  }
  if (!constantsCode.includes('START_CAPTURE')) {
    fail('missing-compat-message', 'START_CAPTURE must remain as the explicit compatibility backend');
  }
}

// 20. Public-repository hygiene ---------------------------------------------------
// The published tree should contain the extension, its tests, and its
// documentation - not the working files of whatever tooling produced it, and
// not machine-specific paths. Only TRACKED files are considered: local scratch
// files are the developer's business, as long as they never get committed.
const trackedFiles = (() => {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  } catch {
    return null; // not a git checkout (e.g. an extracted download) - skip these checks
  }
})();

if (trackedFiles === null) {
  warn('repo-hygiene-skipped', 'not a git checkout - tracked-file hygiene checks were skipped');
} else {
  // Working files for a coding agent, and generated build/validation output,
  // must never be tracked. Matched on the file NAME so a legitimate document
  // is never caught by a path coincidence.
  const AGENT_ONLY_BASENAMES = new Set([
    'claude.md',
    'agents.md',
    'agent.md',
    'codex.md',
    'chatgpt.md',
    'copilot-instructions.md',
    'ai_instructions.md',
    'ai-instructions.md',
  ]);
  const AGENT_ONLY_DIRECTORIES = ['.claude/', '.codex/', '.aider/', 'prompts/'];

  for (const file of trackedFiles) {
    const base = path.basename(file).toLowerCase();

    if (AGENT_ONLY_BASENAMES.has(base)) {
      fail('tracked-agent-file', `${file} is a coding-agent instruction file and must not be tracked`);
    }
    for (const dir of AGENT_ONLY_DIRECTORIES) {
      if (file.toLowerCase().startsWith(dir)) {
        fail('tracked-agent-directory', `${file} lives in an agent working directory and must not be tracked`);
      }
    }
    if (/\.(zip|sha|sha256)$/i.test(base)) {
      fail('tracked-generated-artifact', `${file} is a generated archive/checksum and must not be tracked`);
    }
    if (/^(test-output|audit-output|node-check-output)/.test(base)) {
      fail('tracked-generated-artifact', `${file} is generated validation output and must not be tracked`);
    }
  }

  // Machine-specific absolute paths must not appear in tracked text. Binary
  // files (icons) are skipped; documentation should use neutral examples.
  const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.json', '.html', '.css', '.md', '.txt', '.yml', '.yaml', '']);
  for (const file of trackedFiles) {
    if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    let content;
    try {
      content = readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
      continue;
    }
    if (/\/home\/[a-z0-9_-]+\//i.test(content) || /[A-Z]:\\Users\\/.test(content)) {
      fail('tracked-local-path', `${file} contains a machine-specific absolute path`);
    }
  }

  // Runtime source must not carry provenance markers naming a coding agent.
  // Deliberately specific phrases - never a bare substring like "ai", which
  // would flag gain/main/contain/aria/email and similar ordinary words.
  const PROVENANCE_MARKERS = [
    'generated by claude',
    'generated by chatgpt',
    'generated by codex',
    'generated by copilot',
    'generated by ai',
    'ai-generated',
    'written by an ai',
    'as an ai language model',
    'claude code',
  ];
  for (const [file, content] of runtimeJsEntries) {
    const lowered = content.toLowerCase();
    for (const marker of PROVENANCE_MARKERS) {
      if (lowered.includes(marker)) {
        fail('provenance-marker', `${file} contains the provenance marker "${marker}"`);
      }
    }
  }
}

// ---------------------------------------------------------------------------------
console.log(`Scanned ${runtimeFiles.length} runtime files (manifest.json, service-worker.js, offscreen/, popup/, options/, shared/, page-audio/).`);
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
