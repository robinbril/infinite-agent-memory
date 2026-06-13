#!/usr/bin/env node
/**
 * doctor.js  [--memory-dir <path>]
 *
 * Diagnoses an infinite-agent-memory installation and prints a health report
 * with PASS / WARN / FAIL per check.
 *
 * Exit 0 when no FAIL; exit 1 on any FAIL.
 * Zero external dependencies. Works on Windows and Unix.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const cp   = require('child_process');

// ---- argument parsing ----

const args = process.argv.slice(2);
let memDirArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--memory-dir' && args[i + 1]) { memDirArg = args[i + 1]; i++; }
}

const memDir = memDirArg
  || process.env.AGENT_MEMORY_DIR
  || path.join(os.homedir(), 'agent-memory');

// Repo root is one directory up from scripts/
const repoRoot = path.resolve(__dirname, '..');

// ---- result tracking ----

const results = []; // { label, status, detail }

function pass(label, detail) { results.push({ label, status: 'PASS', detail: detail || '' }); }
function warn(label, detail) { results.push({ label, status: 'WARN', detail: detail || '' }); }
function fail(label, detail) { results.push({ label, status: 'FAIL', detail: detail || '' }); }

// ---- check helpers ----

function nodeVersionCheck() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 18) {
    pass('Node version', `v${process.versions.node} (>= 18)`);
  } else {
    fail('Node version', `v${process.versions.node} -- need >= 18`);
  }
}

function memoryDirCheck() {
  const exists = fs.existsSync(memDir);
  if (!exists) {
    fail('Memory dir exists', `not found: ${memDir}`);
    return false;
  }
  const stat = fs.statSync(memDir);
  if (!stat.isDirectory()) {
    fail('Memory dir exists', `path exists but is not a directory: ${memDir}`);
    return false;
  }
  pass('Memory dir exists', memDir);
  return true;
}

function memorySubdirsCheck() {
  const required = ['entities', 'concepts', 'summaries', 'sources'];
  for (const sub of required) {
    const p = path.join(memDir, sub);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      pass(`Memory subdir: ${sub}`, p);
    } else {
      fail(`Memory subdir: ${sub}`, `missing: ${p}`);
    }
  }
}

function memorySchemaCheck() {
  const p = path.join(memDir, 'SCHEMA.md');
  if (fs.existsSync(p)) {
    pass('SCHEMA.md', p);
  } else {
    fail('SCHEMA.md', `not found: ${p}`);
  }
}

function memoryIndexCheck() {
  const p = path.join(memDir, 'index.md');
  if (fs.existsSync(p)) {
    pass('index.md', p);
  } else {
    warn('index.md', `not found: ${p} (created by first distill run)`);
  }
}

// ---- Claude Code settings.json hook wiring ----

const HOOK_PATTERNS = [
  {
    event: 'SessionStart',
    script: 'hooks/session-recall.js',
    label: 'Hook: SessionStart / session-recall',
  },
  {
    event: 'UserPromptSubmit',
    script: 'hooks/prompt-recall.js',
    label: 'Hook: UserPromptSubmit / prompt-recall',
  },
  {
    event: 'SessionEnd',
    script: 'hooks/session-capture.js',
    label: 'Hook: SessionEnd / session-capture',
  },
];

function settingsJsonPaths() {
  // Claude Code looks for settings.json in ~/.claude/settings.json
  // and .claude/settings.json relative to the working project.
  const candidates = [
    path.join(os.homedir(), '.claude', 'settings.json'),
  ];
  return candidates;
}

function readSettings() {
  for (const p of settingsJsonPaths()) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = fs.readFileSync(p, 'utf8');
      return { path: p, data: JSON.parse(raw) };
    } catch (e) {
      return { path: p, data: null, error: e.message };
    }
  }
  return null;
}

function hookWiringCheck() {
  const settings = readSettings();
  if (!settings) {
    for (const h of HOOK_PATTERNS) {
      warn(h.label, 'settings.json not found in ~/.claude/; hooks cannot be verified');
    }
    return;
  }
  if (settings.error) {
    for (const h of HOOK_PATTERNS) {
      fail(h.label, `could not parse ${settings.path}: ${settings.error}`);
    }
    return;
  }

  const hooks = settings.data && settings.data.hooks;
  if (!hooks || typeof hooks !== 'object') {
    for (const h of HOOK_PATTERNS) {
      fail(h.label, `no "hooks" key in ${settings.path}`);
    }
    return;
  }

  for (const h of HOOK_PATTERNS) {
    const section = hooks[h.event];
    if (!section) {
      fail(h.label, `no "${h.event}" section in hooks (${settings.path})`);
      continue;
    }

    // settings.json supports two formats:
    //   1. Array of hook wrapper objects: [{ "hooks": [{ "command": "..." }] }]
    //   2. Direct array: [{ "command": "..." }]
    // We search for the script filename anywhere in the serialised section.
    const serialised = JSON.stringify(section);
    const scriptName = h.script.replace(/\\/g, '/');
    if (serialised.includes(scriptName)) {
      pass(h.label, `found in ${settings.path}`);
    } else {
      fail(h.label, `"${scriptName}" not found in ${h.event} hooks (${settings.path})`);
    }
  }
}

// ---- hook/script syntax check ----

function syntaxCheck(relPath, label) {
  const abs = path.join(repoRoot, relPath);
  if (!fs.existsSync(abs)) {
    fail(label, `file not found: ${abs}`);
    return;
  }
  try {
    cp.execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
    pass(label, abs);
  } catch (e) {
    const msg = e.stderr ? e.stderr.toString().trim() : e.message;
    fail(label, `syntax error: ${msg}`);
  }
}

function scriptSyntaxChecks() {
  const files = [
    ['hooks/session-recall.js',   'Syntax: hooks/session-recall.js'],
    ['hooks/prompt-recall.js',    'Syntax: hooks/prompt-recall.js'],
    ['hooks/session-capture.js',  'Syntax: hooks/session-capture.js'],
    ['scripts/build-index.js',    'Syntax: scripts/build-index.js'],
    ['scripts/transcript-digest.js', 'Syntax: scripts/transcript-digest.js'],
  ];
  for (const [rel, label] of files) {
    syntaxCheck(rel, label);
  }
}

// ---- capture queue ----

function captureQueueCheck() {
  const queuePath = path.join(memDir, '_capture-queue.jsonl');
  if (!fs.existsSync(queuePath)) {
    pass('Capture queue', 'no queue file (expected before first session is captured)');
    return;
  }
  let lines;
  try {
    lines = fs.readFileSync(queuePath, 'utf8').split('\n').filter(Boolean);
  } catch (e) {
    fail('Capture queue', `could not read ${queuePath}: ${e.message}`);
    return;
  }
  // Validate that every non-empty line is parseable JSON.
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    try { JSON.parse(lines[i]); } catch (_) { bad.push(i + 1); }
  }
  if (bad.length) {
    fail('Capture queue', `${queuePath} has unparseable lines: ${bad.join(', ')}`);
    return;
  }
  const pending = lines.filter(l => { try { return !JSON.parse(l).done; } catch (_) { return false; } }).length;
  const total = lines.length;
  if (pending >= 480) {
    warn('Capture queue', `${pending}/${total} pending -- queue almost full (>=480); run the distill now`);
  } else {
    pass('Capture queue', `${pending} pending, ${total} total entries in ${queuePath}`);
  }
}

// ---- report ----

function printReport() {
  const WIDTH = 56;
  const PAD = 8; // width of "[  PASS  ]"

  console.log('');
  console.log('infinite-agent-memory doctor');
  console.log('='.repeat(WIDTH));

  for (const r of results) {
    const badge =
      r.status === 'PASS' ? '[  PASS  ]' :
      r.status === 'WARN' ? '[  WARN  ]' :
                            '[  FAIL  ]';
    const label = r.label.length > 38 ? r.label.slice(0, 37) + '…' : r.label;
    console.log(`${badge}  ${label}`);
    if (r.detail) {
      // indent detail lines
      const lines = r.detail.split('\n');
      for (const l of lines) console.log(`           ${l}`);
    }
  }

  console.log('='.repeat(WIDTH));

  const pass = results.filter(r => r.status === 'PASS').length;
  const warn = results.filter(r => r.status === 'WARN').length;
  const fail = results.filter(r => r.status === 'FAIL').length;

  console.log(`Summary: ${pass} pass, ${warn} warn, ${fail} fail`);
  if (fail > 0) {
    console.log('Status:  NOT OK -- fix the FAIL items above before using the memory.');
  } else if (warn > 0) {
    console.log('Status:  OK with warnings -- installation usable but review WARN items.');
  } else {
    console.log('Status:  OK -- installation looks healthy.');
  }
  console.log('');
}

// ---- main ----

function main() {
  nodeVersionCheck();

  const memDirOk = memoryDirCheck();
  if (memDirOk) {
    memorySubdirsCheck();
    memorySchemaCheck();
    memoryIndexCheck();
    captureQueueCheck();
  }

  hookWiringCheck();
  scriptSyntaxChecks();

  printReport();

  const hasFail = results.some(r => r.status === 'FAIL');
  process.exit(hasFail ? 1 : 0);
}

main();
