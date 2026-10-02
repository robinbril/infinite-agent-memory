#!/usr/bin/env node
// Wraps session-recall.js output in the additionalContext envelope Codex expects.
const { execSync } = require('child_process');
const path = require('path');
const raw = process.stdin.read() || '';
const repoDir = path.join(__dirname, '..');
let ctx = '';
try {
  ctx = execSync(`"${process.execPath}" "${path.join(repoDir, 'hooks', 'session-recall.js')}"`, {
    input: raw, encoding: 'utf8', timeout: 4000
  });
} catch (_) {}
if (ctx.trim()) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx.trim() }
  }));
}
process.exit(0);
