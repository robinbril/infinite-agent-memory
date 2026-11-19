#!/usr/bin/env node
// Adapts Codex UserPromptSubmit input and wraps recall as additionalContext.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function lastTranscriptPrompt(file) {
  if (typeof file !== 'string' || !file) return '';
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let event;
      try { event = JSON.parse(lines[i]); } catch (_) { continue; }
      if (event?.type !== 'response_item' || event.payload?.role !== 'user') continue;
      const content = event.payload.content;
      if (!Array.isArray(content)) continue;
      const text = content.map(part => part?.text || '').join(' ').trim();
      if (text && !text.startsWith('<environment_context')) return text;
    }
  } catch (_) {
    // Transcript formats and availability vary across older Codex versions.
  }
  return '';
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!input || typeof input !== 'object') return;
  const prompt = Object.hasOwn(input, 'prompt') ? input.prompt : lastTranscriptPrompt(input.transcript_path);
  if (typeof prompt !== 'string' || !prompt.trim()) return;

  const request = JSON.stringify({
    prompt,
    session_id: input.session_id || 'codex',
    cwd: input.cwd || process.cwd()
  });
  const hook = path.join(__dirname, '..', 'hooks', 'prompt-recall.js');
  const ctx = execFileSync(process.execPath, [hook], { input: request, encoding: 'utf8', timeout: 3000 });

  if (ctx.trim()) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx.trim() }
    }));
  }
}

try { main(); } catch (_) {}
