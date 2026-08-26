#!/usr/bin/env node
/**
 * memory-slice.js
 * Gives a subagent/delegate the same memory context the main session gets via
 * prompt-recall.js. Scores the memory pages against a prompt file with the SAME
 * local BM25 over <memory>/_recall-index.json, then writes the top-K page
 * extracts so the orchestrator can prepend them to the worker's prompt.
 *
 * A spawned worker on another model/seat starts with zero memory. prompt-recall
 * covers the interactive main session (per prompt, injected by the hook); this
 * covers the one-shot delegate (per spawn, prepended by the orchestrator).
 *
 * Usage:  node memory-slice.js <promptfile> [out.md]
 *   - out.md given  -> slice written there, path echoed on stdout
 *   - no out path   -> slice written to stdout
 *
 * Memory location: $AGENT_MEMORY_DIR, default ~/agent-memory
 * Index (built by prompt-recall.js): <memory>/_recall-index.json
 *
 * Tuning (env): MEMORY_SLICE_TOP (default 4), MEMORY_SLICE_MIN (default 3.0),
 * MEMORY_SLICE_MAXCHARS (default 9000).
 *
 * Hard rule: ALWAYS exit 0. A missing index, unreadable file, or any error must
 * never break the delegation. On the soft-fail path nothing is written and only
 * an optional one-line notice may go to stderr.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const TOP = parseInt(process.env.MEMORY_SLICE_TOP || '4', 10);
const MIN_SCORE = parseFloat(process.env.MEMORY_SLICE_MIN || '3.0');
const MAX_CHARS = parseInt(process.env.MEMORY_SLICE_MAXCHARS || '9000', 10);

const BM25_K1 = 1.2, BM25_B = 0.75; // same params as prompt-recall.js

// English + Dutch stopwords, matching the recall tokenizer.
const STOP = new Set(('de het een van voor met aan op in te en of als dat die deze dit der des den ' +
  'ik je jij hij zij we wij ze men u mijn jouw zijn haar ons hun er hier daar nu dan al ook nog maar ' +
  'wel niet geen om naar bij uit over onder door tussen tegen sinds tot zonder per wat wie hoe waar ' +
  'wanneer waarom welk welke kan kun kunt moet mag zal zou wil heb hebt heeft had even graag dus toch ' +
  'the a an of for with to and or if that this these those is are was were be been being it its my your ' +
  'his her our their there here now then also still but not no any do does did can could should would ' +
  'will shall may might want have has had just please about into over under from by on in at as so ' +
  'doe maar even kijk maak fix zet check').split(/\s+/));

// soft-fail: write nothing, exit 0. Optional one-line stderr notice.
function bail(note) {
  if (note && process.env.MEMORY_SLICE_DEBUG === '1') process.stderr.write('[memory-slice] ' + note + '\n');
  process.exit(0);
}

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// lowercase, strip diacritics, split on non-alnum, drop stopwords, add a
// suffix-stripped variant for tokens >5 chars. Same as the recall tokenizer.
function tokenize(text) {
  const out = [];
  for (const t of stripDiacritics(String(text).toLowerCase()).split(/[^a-z0-9]+/)) {
    if (t.length < 2 || STOP.has(t)) continue;
    out.push(t);
    if (t.length > 5) {
      const v = t.replace(/('s|en|s)$/, '');
      if (v.length > 2 && v !== t) out.push(v);
    }
  }
  return out;
}

try {
  const memDir = process.env.AGENT_MEMORY_DIR || path.join(os.homedir(), 'agent-memory');
  const idxPath = path.join(memDir, '_recall-index.json');
  const promptfile = process.argv[2];
  const outPath = process.argv[3];

  if (!promptfile || !fs.existsSync(promptfile)) bail('no prompt file');
  if (!fs.existsSync(idxPath)) bail('no index at ' + idxPath);

  let idx;
  try { idx = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch (_) { bail('index unreadable'); }
  const docs = (idx && idx.docs) || [];
  const df = (idx && idx.df) || {};
  const nDocs = (idx && idx.nDocs) || docs.length || 1;
  const avgLen = (idx && idx.avgLen) || 100;
  if (!docs.length) bail('empty index');

  const q = fs.readFileSync(promptfile, 'utf8').slice(0, 20000);
  const qUnique = [...new Set(tokenize(q))];
  if (!qUnique.length) bail('no query tokens');

  // BM25 over the existing index. idf per query term from df.
  const ranked = [];
  for (const d of docs) {
    const tf = d.tf || {};
    const len = d.len || avgLen;
    let s = 0;
    for (const t of qUnique) {
      const f = tf[t];
      if (!f) continue;
      const n = df[t] || 1;
      const idf = Math.log(1 + (nDocs - n + 0.5) / (n + 0.5));
      s += idf * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * len / avgLen));
    }
    if (s > 0) ranked.push({ d, s });
  }
  ranked.sort((a, b) => b.s - a.s);
  const picks = ranked.filter(r => r.s >= MIN_SCORE).slice(0, TOP);
  if (!picks.length) bail('no page over min score');

  // Prefer the full page (freshest); fall back to the cached extract.
  let body = '';
  for (const { d } of picks) {
    let text = '';
    if (d.path) {
      try { text = fs.readFileSync(path.join(memDir, d.path), 'utf8'); } catch (_) {}
    }
    if (!text) text = d.extract || '';
    if (!text) continue;
    body += `\n----- MEMORY: ${d.title || d.slug || d.path} -----\n${text.trim()}\n`;
    if (body.length > MAX_CHARS) { body = body.slice(0, MAX_CHARS) + '\n[...truncated...]\n'; break; }
  }
  if (!body.trim()) bail('picks had no readable content');

  const header = '# Memory slice (background knowledge retrieved for this task)\n' +
    '# Snapshot; verify claims about code/files before stating them as fact.\n';
  const payload = header + body;

  if (outPath) {
    fs.writeFileSync(outPath, payload, 'utf8');
    process.stdout.write(outPath);
  } else {
    process.stdout.write(payload);
  }
  process.exit(0);
} catch (e) {
  bail(e && e.message);
}
