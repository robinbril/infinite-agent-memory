#!/usr/bin/env node
// Cursor sessionStart hook: wraps session-recall.js output in the
// {"additional_context": "..."} envelope Cursor expects.
const { execFileSync } = require('child_process');
const path = require('path');
let ctx = '';
try {
  ctx = execFileSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'session-recall.js')], {
    input: '{}', encoding: 'utf8', timeout: 4000
  });
} catch (_) {}
process.stdout.write(JSON.stringify(ctx.trim() ? { additional_context: ctx.trim() } : {}));
process.exit(0);
