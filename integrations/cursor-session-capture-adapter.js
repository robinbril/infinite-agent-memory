#!/usr/bin/env node
// Cursor sessionEnd hook: maps Cursor's stdin (workspace_roots instead of cwd)
// onto the fields session-capture.js reads, then queues the transcript.
const { execFileSync } = require('child_process');
const path = require('path');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch (_) {}
  const synth = JSON.stringify({
    session_id: input.session_id || input.conversation_id || 'cursor',
    transcript_path: input.transcript_path || '',
    cwd: input.cwd || (Array.isArray(input.workspace_roots) && input.workspace_roots[0]) || ''
  });
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'session-capture.js')], {
      input: synth, encoding: 'utf8', timeout: 14000
    });
  } catch (_) {}
  process.exit(0);
});
