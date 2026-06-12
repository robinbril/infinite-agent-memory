#!/usr/bin/env node
/**
 * session-capture.js
 * SessionEnd hook: queues substantial sessions for the periodic distill run
 * (scripts/distill.ps1 or distill.sh), UNLESS this session already folded its
 * own knowledge into memory (i.e. it wrote inside the memory directory).
 *
 * Each queue entry is rich enough for the distiller to prioritise without first
 * opening every transcript: topic (first real user message), size, files-touched.
 *
 * Queue: <memory>/_capture-queue.jsonl (one JSON object per line).
 * Surfaced at next SessionStart by session-recall.js. Entries are marked
 * `done:true` by the distill run, not deleted, so the queue doubles as an audit log.
 *
 * Memory location: $AGENT_MEMORY_DIR, default ~/agent-memory
 * Non-blocking: always exits 0.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const memDir = process.env.AGENT_MEMORY_DIR || path.join(os.homedir(), 'agent-memory');
const queuePath = path.join(memDir, '_capture-queue.jsonl');

const SUBSTANTIAL_BYTES = 40 * 1024; // skip trivial sessions
const MAX_QUEUE = 500;
const TOPIC_MAX = 200;
// forward-slash normalised path fragment meaning "wrote into memory"
const MEM_MARKER = memDir.replace(/\\/g, '/').split('/').slice(-2).join('/');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { raw += c; });
process.stdin.on('end', () => {
  try { main(JSON.parse(raw || '{}')); } catch (_) {}
  process.exit(0);
});

// Single pass over the transcript: first real user message, files-modified count,
// and whether this session wrote into memory itself.
function scanTranscript(file) {
  const out = { topic: '', filesModified: 0, wroteToMemory: false };
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch (_) { return out; }

  for (const ln of lines) {
    if (!ln) continue;
    let o;
    try { o = JSON.parse(ln); } catch (_) { continue; }

    if (!out.topic && o.type === 'user' && o.message) {
      const c = o.message.content;
      let txt = typeof c === 'string'
        ? c
        : (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : p.text || '')).join(' ') : '');
      txt = txt.trim();
      // skip slash-commands, system reminders / tool-result envelopes
      if (txt && !txt.startsWith('/') && !txt.startsWith('<')) {
        out.topic = txt.replace(/\s+/g, ' ').slice(0, TOPIC_MAX);
      }
    }

    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const p of o.message.content) {
        if (p.type !== 'tool_use') continue;
        if (p.name === 'Write' || p.name === 'Edit' || p.name === 'NotebookEdit') {
          out.filesModified += 1;
          const fp = p.input && p.input.file_path;
          if (fp && String(fp).replace(/\\/g, '/').includes(MEM_MARKER)) out.wroteToMemory = true;
        }
      }
    }
  }
  return out;
}

function main(input) {
  if (!fs.existsSync(memDir)) return;

  const transcript = input.transcript_path || '';
  let size = 0;
  try { size = fs.statSync(transcript).size; } catch (_) {}
  if (size < SUBSTANTIAL_BYTES) return;

  const scan = scanTranscript(transcript);
  if (scan.wroteToMemory) return; // this session already folded its knowledge in

  let queue = [];
  try {
    queue = fs.readFileSync(queuePath, 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (_) {}

  const sessionId = input.session_id || '';
  if (sessionId && queue.some(q => q.sessionId === sessionId)) return;

  queue.push({
    ts: new Date().toISOString().slice(0, 16),
    sessionId,
    cwd: input.cwd || '',
    transcriptPath: transcript,
    sizeKB: Math.round(size / 1024),
    topic: scan.topic,
    filesModified: scan.filesModified
  });
  queue = queue.slice(-MAX_QUEUE);

  try {
    const tmp = queuePath + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, queue.map(q => JSON.stringify(q)).join('\n') + '\n');
    fs.renameSync(tmp, queuePath);
  } catch (_) {}
}
