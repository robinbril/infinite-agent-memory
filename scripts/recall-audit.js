#!/usr/bin/env node
/**
 * recall-audit.js [--days N]   (default 30)
 *
 * Measures whether injected memory pages actually get used, so you can tune
 * recall on evidence instead of vibes. An injection counts as "used" when the
 * page slug appears later in the same transcript inside an assistant event:
 * the assistant mentioned it, or read the full page (tool calls live in
 * assistant events). Within a sequential pass, use can only be found AFTER the
 * injection, so ordering is handled for free.
 *
 * The "used" number is a LOWER BOUND: an assistant that silently applies the
 * knowledge without naming the page does not count. Interpret accordingly.
 * The signal to act on is the opposite end: pages with many injections and
 * zero use are noise; sharpen their description or raise the gates. Measured
 * in production, this audit caught a page injected 1110 times in 14 days with
 * zero use (a 15-minute cron matched it every run), which led to the daily
 * cap in prompt-recall.js.
 *
 * Reads Claude Code transcripts (JSONL) from CLAUDE_PROJECTS_DIR, default
 * ~/.claude/projects. Matches both <memory-recall> (this repo) and
 * <wiki-recall> (older installs) markers.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const projectsDir = process.env.CLAUDE_PROJECTS_DIR ||
  path.join(os.homedir(), '.claude', 'projects');

const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg > -1 ? Number(process.argv[daysArg + 1]) || 30 : 30;
const CUTOFF = Date.now() - DAYS * 24 * 60 * 60 * 1000;

const INJECT_RE = /(?:memory|wiki)-recall source=\\?"([^"\\]+\.md)/g;
const CHUNK = 8 * 1024 * 1024;

function listTranscripts() {
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir, d.name);
    let files; try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs >= CUTOFF) out.push(p); } catch (_) {}
    }
  }
  return out;
}

function slugOf(rel) { return path.basename(rel, '.md'); }

function auditFile(p, stats) {
  const fd = fs.openSync(p, 'r');
  const buf = Buffer.alloc(CHUNK);
  // slugs injected in this file, still waiting for a use signal
  const pending = new Map(); // slug -> rel
  try {
    let pos = 0, tail = '';
    while (true) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      pos += n;
      const text = tail + buf.toString('utf8', 0, n);

      // 1. register new injections
      let m;
      INJECT_RE.lastIndex = 0;
      while ((m = INJECT_RE.exec(text)) !== null) {
        const rel = m[1];
        const slug = slugOf(rel);
        const s = stats.get(rel) || { injected: 0, used: 0 };
        s.injected += 1;
        stats.set(rel, s);
        pending.set(slug, rel);
      }

      // 2. look for use: the slug on an assistant-event line. The injection
      // itself sits in user events, so an assistant line naming the slug is
      // real assistant work (a mention or a Read of the page).
      for (const [slug, rel] of pending) {
        const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('"type":"assistant"[^\\n]*' + esc, 'i');
        if (re.test(text)) {
          stats.get(rel).used += 1;
          pending.delete(slug);
        }
      }
      tail = text.slice(-2048);
    }
  } finally { fs.closeSync(fd); }
}

function main() {
  const files = listTranscripts();
  const stats = new Map();
  for (const p of files) { try { auditFile(p, stats); } catch (_) {} }

  const rows = [...stats.entries()]
    .map(([rel, s]) => ({ rel, ...s }))
    .sort((a, b) => b.injected - a.injected);

  const totInj = rows.reduce((a, r) => a + r.injected, 0);
  const totUsed = rows.reduce((a, r) => a + r.used, 0);
  console.log(`recall-audit over ${files.length} transcripts (last ${DAYS} days)`);
  console.log(`total: ${totInj} injections, ${totUsed} used (${totInj ? Math.round(totUsed / totInj * 100) : 0}%, a lower bound)\n`);
  console.log('inj  used  page');
  for (const r of rows.slice(0, 20)) {
    console.log(`${String(r.injected).padStart(3)}  ${String(r.used).padStart(4)}  ${r.rel}`);
  }
  const dead = rows.filter(r => r.injected >= 3 && r.used === 0);
  if (dead.length) {
    console.log('\nZero use at 3+ injections (sharpen the description, or raise the gates):');
    for (const r of dead) console.log(`  ${r.injected}x  ${r.rel}`);
  }
}

main();
