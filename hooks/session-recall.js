#!/usr/bin/env node
/**
 * session-recall.js
 * SessionStart hook: injects the memory index (the map of what the agent
 * knows) into the session context, plus a nudge when captured sessions are
 * waiting to be distilled.
 *
 * The index gives the model awareness of WHAT exists; prompt-recall.js then
 * injects targeted page content just-in-time per prompt.
 *
 * Memory location: $AGENT_MEMORY_DIR, default ~/agent-memory
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const memDir = process.env.AGENT_MEMORY_DIR || path.join(os.homedir(), 'agent-memory');
const indexPath = path.join(memDir, 'index.md');

let body = '';
try { body = fs.readFileSync(indexPath, 'utf8'); } catch (_) {}

// inject the index map only when it actually lists pages; the capture nudge
// below still runs for an empty memory (first sessions queue before the
// first distill has produced any pages).
if (/\n\s*-\s+\[/.test(body)) {
  const max = 4000;
  const trimmed = body.length > max ? body.slice(0, max) + '\n...(truncated)' : body;
  process.stdout.write(`<memory-recall>\n${trimmed}\n</memory-recall>\n`);
}

// Surface the capture queue: sessions not yet folded into memory.
try {
  const queuePath = path.join(memDir, '_capture-queue.jsonl');
  if (fs.existsSync(queuePath)) {
    const lines = fs.readFileSync(queuePath, 'utf8').split('\n').filter(Boolean);
    const pending = lines.filter(l => { try { return !JSON.parse(l).done; } catch (_) { return false; } }).length;
    if (pending >= 1) {
      let last = '';
      try { last = JSON.parse(lines[lines.length - 1]).ts || ''; } catch (_) {}
      const full = lines.length >= 480
        ? ' QUEUE NEARLY FULL (>=480): oldest sessions will be dropped, run the distill now.'
        : '';
      process.stdout.write(`<memory-capture-pending>\n${pending} session(s) waiting for memory distillation${last ? ` (latest: ${last})` : ''}.${full}\n</memory-capture-pending>\n`);
    }
  }
} catch (_) {}

process.exit(0);
