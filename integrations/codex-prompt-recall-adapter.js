#!/usr/bin/env node
// Reads the latest user message from transcript_path (Codex format),
// synthesises the "prompt" field prompt-recall.js expects, and wraps
// the output in the additionalContext envelope.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch (_) {}

  // Extract last user message from transcript (Codex format: response_item entries)
  let lastPrompt = '';
  const tp = input.transcript_path || '';
  if (tp && fs.existsSync(tp)) {
    try {
      const lines = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        let o;
        try { o = JSON.parse(lines[i]); } catch (_) { continue; }
        if (o.type === 'response_item' && o.payload && o.payload.role === 'user') {
          const c = o.payload.content;
          if (Array.isArray(c)) {
            const txt = c.map(p => (p && p.text) || '').join(' ').trim();
            if (txt && !txt.startsWith('<environment_context')) { lastPrompt = txt; break; }
          }
        }
      }
    } catch (_) {}
  }

  if (!lastPrompt) { process.exit(0); }

  const synth = JSON.stringify({
    prompt: lastPrompt,
    session_id: input.session_id || 'codex',
    cwd: input.cwd || process.cwd()
  });

  const repoDir = path.join(__dirname, '..');
  let ctx = '';
  try {
    ctx = execSync(`"${process.execPath}" "${path.join(repoDir, 'hooks', 'prompt-recall.js')}"`, {
      input: synth, encoding: 'utf8', timeout: 3000
    });
  } catch (_) {}

  if (ctx.trim()) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx.trim() }
    }));
  }
  process.exit(0);
});
