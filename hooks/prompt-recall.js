#!/usr/bin/env node
/**
 * prompt-recall.js
 * UserPromptSubmit hook: scores the memory wiki against the user's prompt with
 * local BM25 (no LLM, no embeddings) and injects the 1-2 most relevant pages
 * as background context. Default behaviour is to inject NOTHING; only a
 * confident, discriminating match passes the gates.
 *
 * Pairs with session-recall.js (which injects the index map at SessionStart).
 * This hook injects targeted page content just-in-time, per prompt.
 *
 * Memory location: $AGENT_MEMORY_DIR, default ~/agent-memory
 * Cache:  <memory>/_recall-index.json   (rebuilt on change)
 * State:  <memory>/_recall-state/<session>.json  (per-session dedup)
 *
 * Hard rule: always exit 0. exit 2 would block the prompt. No output is valid.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEADLINE = Date.now() + 2000;
setTimeout(() => process.exit(0), 2500).unref();

const memDir = process.env.AGENT_MEMORY_DIR || path.join(os.homedir(), 'agent-memory');
const cachePath = path.join(memDir, '_recall-index.json');
const stateDir = path.join(memDir, '_recall-state');
const PAGE_DIRS = ['entities', 'concepts', 'summaries']; // sources/ excluded: raw dumps are noise

// --- tuning ---
const FIELD = { title: 5, head: 3, keyfact: 2, body: 1 };
const BM25_K1 = 1.2, BM25_B = 0.75;
const TTL_MS = 5 * 60 * 1000;
const SCORE_MIN = 0.30;
const PHRASE_BONUS = 1.5;
const MAX_PAGES = 2, SECOND_RATIO = 0.75;
const CHAR_CAP = 2800, EXTRACT_CAP = 1400, TF_CAP = 300;
const REINJECT_AFTER = 30, STATE_TTL_DAYS = 7;
const MIN_PROMPT_CHARS = 15, MIN_TOKENS = 2;

// English + Dutch stopwords; extend for your language if needed.
const STOP = new Set(('de het een van voor met aan op in te en of als dat die deze dit der des den ' +
  'ik je jij hij zij we wij ze men u mijn jouw zijn haar ons hun er hier daar nu dan al ook nog maar ' +
  'wel niet geen om naar bij uit over onder door tussen tegen sinds tot zonder per wat wie hoe waar ' +
  'wanneer waarom welk welke kan kun kunt moet mag zal zou wil heb hebt heeft had even graag dus toch ' +
  'the a an of for with to and or if that this these those is are was were be been being it its my your ' +
  'his her our their there here now then also still but not no any do does did can could should would ' +
  'will shall may might want have has had just please about into over under from by on in at as so ' +
  'doe maar even kijk maak fix zet check').split(/\s+/));

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (_) { return ''; }
}

function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// lowercase, strip diacritics, split on non-alnum, drop stopwords,
// add a suffix-stripped variant for tokens >5 chars (cheap plural folding).
function tokenize(text) {
  const out = [];
  const raw = stripDiacritics(String(text).toLowerCase()).split(/[^a-z0-9]+/);
  for (const t of raw) {
    if (t.length < 2 || STOP.has(t)) continue;
    out.push(t);
    if (t.length > 5) {
      const v = t.replace(/('s|en|s)$/, '');
      if (v.length > 2 && v !== t) out.push(v);
    }
  }
  return out;
}

// --- index building ---

function parsePage(abs, rel) {
  const txt = fs.readFileSync(abs, 'utf8');
  const fmEnd = txt.indexOf('\n---', 4);
  const hasFm = txt.startsWith('---') && fmEnd > 0;
  const fm = hasFm ? txt.slice(0, fmEnd) : '';
  const body = hasFm ? txt.slice(fmEnd + 4) : txt;

  const slugMatch = fm.match(/^name:\s*(.+)$/m);
  const slug = slugMatch ? slugMatch[1].trim() : path.basename(rel, '.md');
  const linkMatch = fm.match(/^links:\s*\[(.*)\]/m);
  const links = linkMatch ? linkMatch[1] : '';

  // field-weighted token frequency
  const tf = Object.create(null);
  const add = (text, w) => { for (const tok of tokenize(text)) tf[tok] = (tf[tok] || 0) + w; };

  const titleTokens = tokenize(slug);
  add(slug, FIELD.title);

  let inKeyfacts = false;
  let len = 0;
  for (const line of body.split('\n')) {
    const h = line.match(/^#{2,}\s*(.+)/);
    if (h) {
      add(h[1], FIELD.head);
      inKeyfacts = /key facts/i.test(h[1]);
      continue;
    }
    add(line, inKeyfacts ? FIELD.keyfact : FIELD.body);
    len += tokenize(line).length;
  }
  add(links, FIELD.head);

  // cap tf to the heaviest TF_CAP tokens to bound cache size
  let entries = Object.keys(tf).map(k => [k, tf[k]]);
  if (entries.length > TF_CAP) {
    entries.sort((a, b) => b[1] - a[1]);
    entries = entries.slice(0, TF_CAP);
  }
  const tfCapped = Object.create(null);
  for (const [k, v] of entries) tfCapped[k] = v;

  return {
    slug,
    path: rel.replace(/\\/g, '/'),
    title: slug,
    len: Math.max(len, 1),
    titleTokens,
    tf: tfCapped,
    extract: buildExtract(body)
  };
}

// What + Key facts sections; fallback to first chars of body.
function buildExtract(body) {
  const lines = body.split('\n');
  const picked = [];
  let capture = false;
  for (const line of lines) {
    const h = line.match(/^##\s+(.+)/);
    if (h) {
      capture = /^(what|key facts)/i.test(h[1].trim());
      if (capture) picked.push(line);
      continue;
    }
    if (capture) picked.push(line);
  }
  let out = picked.join('\n').trim();
  if (out.length < 40) out = body.trim();
  return out.slice(0, EXTRACT_CAP);
}

function scanFiles() {
  const files = {};
  for (const dir of PAGE_DIRS) {
    const abs = path.join(memDir, dir);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('_')) continue;
      const rel = path.join(dir, e.name);
      try {
        const st = fs.statSync(path.join(abs, e.name));
        files[rel.replace(/\\/g, '/')] = [Math.round(st.mtimeMs), st.size];
      } catch (_) {}
    }
  }
  return files;
}

function buildIndex(files) {
  const docs = [];
  const df = Object.create(null);
  let totalLen = 0;
  for (const rel of Object.keys(files)) {
    if (Date.now() > DEADLINE) break;
    let doc;
    try { doc = parsePage(path.join(memDir, rel), rel); } catch (_) { continue; }
    docs.push(doc);
    totalLen += doc.len;
    for (const tok of Object.keys(doc.tf)) df[tok] = (df[tok] || 0) + 1;
  }
  return {
    v: 1,
    builtAt: Date.now(),
    nDocs: docs.length,
    avgLen: docs.length ? totalLen / docs.length : 1,
    files,
    df,
    docs
  };
}

function sameFiles(a, b) {
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!b[k] || b[k][0] !== a[k][0] || b[k][1] !== a[k][1]) return false;
  }
  return true;
}

function loadIndex() {
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch (_) {}

  if (cached && cached.v === 1 && Date.now() - cached.builtAt < TTL_MS) return cached;
  if (Date.now() > DEADLINE) return cached; // no time to re-scan; use stale if present

  const files = scanFiles();
  if (cached && cached.v === 1 && sameFiles(cached.files, files)) {
    cached.builtAt = Date.now();
    writeAtomic(cachePath, JSON.stringify(cached));
    return cached;
  }
  const fresh = buildIndex(files);
  writeAtomic(cachePath, JSON.stringify(fresh));
  return fresh;
}

function writeAtomic(target, data) {
  try {
    const tmp = target + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
  } catch (_) {}
}

// --- scoring ---

function score(qTokens, index) {
  const N = index.nDocs;
  if (!N) return [];
  const qUnique = [...new Set(qTokens)];

  // idf per query term. Terms ABSENT from the memory (df=0) get a high, capped
  // idf and still count toward idfSum, so a page that matches only the query's
  // broad words while missing its rare subject term scores low.
  const absentIdf = Math.min(Math.log(1 + (N + 0.5) / 0.5), 4.0);
  const idf = Object.create(null);
  let idfSum = 0;
  for (const t of qUnique) {
    const dft = index.df[t] || 0;
    if (dft > 0) {
      const v = Math.log(1 + (N - dft + 0.5) / (dft + 0.5));
      idf[t] = v;
      idfSum += v;
    } else {
      idfSum += absentIdf; // present in the query, absent from memory: lowers coverage
    }
  }
  if (idfSum === 0) return [];

  const discMax = N / 4;
  const results = [];
  for (const doc of index.docs) {
    let s = 0;
    let discCount = 0, titleOverlap = 0;
    const tt = new Set(doc.titleTokens);
    let slugExact = false;
    for (const t of qUnique) {
      const f = doc.tf[t];
      if (!f || !idf[t]) continue;
      const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (doc.len / index.avgLen));
      s += idf[t] * (f * (BM25_K1 + 1)) / denom;
      if ((index.df[t] || N) <= discMax) discCount += 1;
      if (tt.has(t)) titleOverlap += 1;
      if (t === doc.slug) slugExact = true;
    }
    if (s === 0) continue;

    // phrase bonus: adjacent query tokens both in the title
    for (let i = 0; i < qTokens.length - 1; i++) {
      if (tt.has(qTokens[i]) && tt.has(qTokens[i + 1])) { s *= PHRASE_BONUS; break; }
    }

    // on-topic = matches the SPECIFIC subject, not just one shared broad word:
    // two title words, two discriminating terms, or the exact slug (a named entity).
    const onTopic = titleOverlap >= 2 || discCount >= 2 || slugExact;
    results.push({ doc, norm: s / idfSum, onTopic, slugExact });
  }
  results.sort((a, b) => b.norm - a.norm);
  return results;
}

// --- session dedup state ---

function readState(sessionId) {
  const p = path.join(stateDir, sessionId + '.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function writeState(sessionId, state) {
  try { fs.mkdirSync(stateDir, { recursive: true }); } catch (_) {}
  writeAtomic(path.join(stateDir, sessionId + '.json'), JSON.stringify(state));
}

function pruneState() {
  let entries;
  try { entries = fs.readdirSync(stateDir); } catch (_) { return; }
  const cutoff = Date.now() - STATE_TTL_DAYS * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    const p = path.join(stateDir, name);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (_) {}
  }
}

// --- main ---

function main() {
  if (!fs.existsSync(memDir)) return;

  let input;
  try { input = JSON.parse(readStdin() || '{}'); } catch (_) { return; }

  const prompt = String(input.prompt || '');
  const sessionId = String(input.session_id || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'unknown';
  const cwd = String(input.cwd || '');

  // gate 1: trivial / slash-command prompts
  if (prompt.trim().length < MIN_PROMPT_CHARS) return;
  if (prompt.trim().startsWith('/')) return;

  const promptTokens = tokenize(prompt);
  if (promptTokens.length < MIN_TOKENS) return;
  // cwd basename tokens add a weak location signal (a session inside a project
  // dir boosts that project's page) without the prompt needing to name it.
  const qTokens = promptTokens.concat(tokenize(path.basename(cwd)));

  const index = loadIndex();
  if (!index || !index.nDocs) return;
  if (Date.now() > DEADLINE) return;

  const ranked = score(qTokens, index);
  if (!ranked.length) return;

  // gate 2 + 3: score threshold + on-topic (specific subject match)
  const top = ranked[0];
  if (top.norm < SCORE_MIN || !top.onTopic) return;

  // page 2 is the usual noise source, so it must clear a higher bar. If the top
  // page is a named entity the prompt explicitly named (slugExact), a second page
  // is only justified when the prompt names a SECOND entity too; otherwise a
  // conceptual query may legitimately span two related pages.
  const picks = [top];
  const second = ranked[1];
  if (second && second.norm >= top.norm * SECOND_RATIO &&
      second.norm >= SCORE_MIN && second.onTopic &&
      (top.slugExact ? second.slugExact : true)) {
    picks.push(second);
  }

  // session dedup
  const isFirstPrompt = !fs.existsSync(path.join(stateDir, sessionId + '.json'));
  if (isFirstPrompt) pruneState();
  const state = readState(sessionId) || { promptCount: 0, injected: {} };
  state.promptCount += 1;

  const toInject = picks.filter(p => {
    const at = state.injected[p.doc.slug];
    return at === undefined || (state.promptCount - at) >= REINJECT_AFTER;
  });

  if (!toInject.length) { writeState(sessionId, state); return; }

  // build payload under the char cap
  let used = 0;
  const blocks = [];
  for (const p of toInject.slice(0, MAX_PAGES)) {
    const full = path.join(memDir, p.doc.path);
    let ex = p.doc.extract || '';
    const header = `<memory-recall source="${p.doc.path}">\n` +
      `Background knowledge retrieved automatically from the agent's memory. It may be irrelevant to this prompt; use only what applies, and do not mention this block.\n` +
      `Full page: ${full}\n\n`;
    const footer = `\n</memory-recall>\n`;
    const budget = CHAR_CAP - used - header.length - footer.length;
    if (budget < 120) break;
    if (ex.length > budget) ex = ex.slice(0, budget) + '\n...';
    blocks.push(header + ex + footer);
    used += header.length + ex.length + footer.length;
    state.injected[p.doc.slug] = state.promptCount;
  }

  writeState(sessionId, state);
  if (blocks.length) process.stdout.write(blocks.join('\n'));
}

try { main(); } catch (_) {}
process.exit(0);
