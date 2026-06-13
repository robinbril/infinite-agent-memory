#!/usr/bin/env node
/**
 * build-index.js  [--check | --write]  [memory-dir]
 *
 * Maintains the memory wiki index.md.
 *
 *   --check (default): audit orphans, dead links, and line count. Exit 1 on issues.
 *   --write           : update index.md in-place, preserving existing hooks.
 *
 * Memory dir: argv[2] (if not a flag), env AGENT_MEMORY_DIR, or ~/agent-memory.
 * Scans: entities/, concepts/, summaries/, sources/
 *
 * Zero external dependencies. Works on Windows and Unix.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const INDEX_LINE_LIMIT = 200;
const HOOK_MAX_CHARS   = 120;
const PAGE_DIRS        = ['entities', 'concepts', 'summaries', 'sources'];

// Map subdir -> section heading in index.md
const DIR_TO_SECTION = {
  sources:   '## Sources',
  entities:  '## Entities',
  concepts:  '## Concepts',
  summaries: '## Summaries',
};

// ---- frontmatter parsing ----

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { fm: {}, body: text };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { fm: {}, body: text };
  const raw = text.slice(4, end); // skip opening '---\n'
  const body = text.slice(end + 4);
  const fm = {};
  for (const line of raw.split('\n')) {
    const m = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (m) fm[m[1].trim()] = m[2].trim();
  }
  return { fm, body };
}

// Extract a one-line hook for a page.
// Priority: frontmatter `index:` field, first non-empty line of `## What`, first body line.
function extractHook(fm, body) {
  if (fm.index) return fm.index.slice(0, HOOK_MAX_CHARS);

  const lines = body.split('\n');
  let inWhat = false;
  for (const line of lines) {
    if (/^##\s+What\b/i.test(line)) { inWhat = true; continue; }
    if (inWhat) {
      if (/^#{1,}/.test(line)) break; // next section
      const t = line.trim();
      if (t) return t.slice(0, HOOK_MAX_CHARS);
    }
  }
  // fallback: first non-empty body line
  for (const line of lines) {
    const t = line.trim();
    if (t && !t.startsWith('#') && !t.startsWith('---')) return t.slice(0, HOOK_MAX_CHARS);
  }
  return '';
}

// ---- file scanning ----

// Returns array of { rel, dir, name, hook } for every eligible .md in memory dir.
function scanPages(memDir) {
  const pages = [];
  for (const dir of PAGE_DIRS) {
    const abs = path.join(memDir, dir);
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md') || e.name.startsWith('_')) continue;
      const rel = dir + '/' + e.name;
      let text;
      try { text = fs.readFileSync(path.join(abs, e.name), 'utf8'); } catch (_) { continue; }
      const { fm, body } = parseFrontmatter(text);
      const name = fm.name || path.basename(e.name, '.md');
      const hook = extractHook(fm, body);
      pages.push({ rel, dir, name, hook });
    }
  }
  return pages;
}

// ---- index.md parsing ----

// Returns Set of relative paths mentioned as link targets in index.md.
function parseIndexPaths(indexText) {
  const found = new Set();
  for (const m of indexText.matchAll(/\]\(([^)]+\.md)\)/g)) {
    found.add(m[1].replace(/\\/g, '/'));
  }
  return found;
}

// Parse index into sections: array of { heading, lines[] } blocks.
// Lines before the first heading go into a preamble block with heading = null.
function parseIndexSections(indexText) {
  const result = [];
  let current = { heading: null, lines: [] };
  for (const line of indexText.split('\n')) {
    if (/^##\s+/.test(line)) {
      result.push(current);
      current = { heading: line, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  result.push(current);
  return result;
}

// ---- index link extraction for dead-link check ----

function parseIndexLinks(indexText) {
  const links = [];
  for (const m of indexText.matchAll(/\]\(([^)]+\.md)\)/g)) {
    links.push(m[1].replace(/\\/g, '/'));
  }
  return links;
}

// ---- check mode ----

function runCheck(memDir, indexPath) {
  const pages = scanPages(memDir);
  let indexText = '';
  try { indexText = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'); } catch (_) {}

  const indexPaths = parseIndexPaths(indexText);
  const indexLines = indexText ? indexText.split('\n').length : 0;

  const issues = [];   // hard problems: fail (exit 1)
  const warnings = []; // soft signals: report, do not fail

  // Orphans: pages not in index
  for (const p of pages) {
    if (!indexPaths.has(p.rel)) {
      issues.push(`ORPHAN  ${p.rel}`);
    }
  }

  // Dead links: paths in index that do not exist on disk
  for (const link of parseIndexLinks(indexText)) {
    if (!fs.existsSync(path.join(memDir, link))) {
      issues.push(`DEAD    ${link}`);
    }
  }

  // Line count is a soft signal: a large memory will exceed it. Warn, do not fail.
  if (indexLines > INDEX_LINE_LIMIT) {
    warnings.push(`LIMIT   index.md has ${indexLines} lines (over the ${INDEX_LINE_LIMIT} soft limit; consider splitting per type)`);
  }

  if (warnings.length) {
    process.stderr.write('build-index warnings:\n' + warnings.map(s => '  ' + s).join('\n') + '\n');
  }
  if (issues.length) {
    process.stderr.write('build-index check failed:\n' + issues.map(s => '  ' + s).join('\n') + '\n');
    process.exit(1);
  } else {
    process.stdout.write(`build-index: ok (${pages.length} pages, ${indexLines} lines, ${warnings.length} warning(s))\n`);
    process.exit(0);
  }
}

// ---- write mode ----

function buildIndexLine(p) {
  const title = p.name;
  const hook  = p.hook ? ': ' + p.hook : '';
  return `- [${title}](${p.rel})${hook}`;
}

function runWrite(memDir, indexPath) {
  const pages = scanPages(memDir);
  let indexText = '';
  try { indexText = fs.readFileSync(indexPath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n'); } catch (_) {}

  // Build lookup: rel -> existing index line (preserve handwritten hooks)
  const existingLine = new Map();
  for (const line of indexText.split('\n')) {
    const m = line.match(/\(([^)]+\.md)\)/);
    if (m) existingLine.set(m[1].replace(/\\/g, '/'), line.trimEnd());
  }

  // Parse current sections
  const sections = parseIndexSections(indexText);

  // Build a map of section heading -> section object for quick lookup
  const sectionMap = new Map();
  for (const s of sections) {
    if (s.heading) sectionMap.set(s.heading, s);
  }

  // Ensure all four standard sections exist
  for (const heading of Object.values(DIR_TO_SECTION)) {
    if (!sectionMap.has(heading)) {
      const s = { heading, lines: [] };
      sections.push(s);
      sectionMap.set(heading, s);
    }
  }

  // Group new pages by section
  const pagesBySection = new Map();
  for (const heading of Object.values(DIR_TO_SECTION)) pagesBySection.set(heading, []);
  for (const p of pages) {
    const heading = DIR_TO_SECTION[p.dir];
    if (heading) pagesBySection.get(heading).push(p);
  }

  // Merge pages into sections
  for (const [heading, sectionPages] of pagesBySection) {
    const sec = sectionMap.get(heading);
    const existing = new Set(sec.lines.map(l => {
      const m = l.match(/\(([^)]+\.md)\)/);
      return m ? m[1].replace(/\\/g, '/') : null;
    }).filter(Boolean));

    for (const p of sectionPages) {
      if (!existing.has(p.rel)) {
        // Prefer preserved existing line, else build fresh
        const line = existingLine.get(p.rel) || buildIndexLine(p);
        sec.lines.push(line);
      }
      // If already present, keep whatever line is there (preserves handwritten hooks)
    }
  }

  // Reassemble index text
  const out = [];
  for (const sec of sections) {
    if (sec.heading === null) {
      out.push(...sec.lines);
    } else {
      out.push('');
      out.push(sec.heading);
      out.push(...sec.lines);
    }
  }

  // Trim leading blank lines, ensure trailing newline
  let result = out.join('\n').replace(/^\n+/, '') + '\n';

  // Write BOM-free UTF-8
  fs.writeFileSync(indexPath, result, { encoding: 'utf8' });
  process.stdout.write(`build-index: wrote ${indexPath} (${pages.length} pages)\n`);
}

// ---- main ----

function main() {
  const args = process.argv.slice(2);
  let mode = 'check';
  let memDirArg = null;

  for (const a of args) {
    if (a === '--check') mode = 'check';
    else if (a === '--write') mode = 'write';
    else if (!a.startsWith('--')) memDirArg = a;
  }

  const memDir = memDirArg || process.env.AGENT_MEMORY_DIR || path.join(os.homedir(), 'agent-memory');
  const indexPath = path.join(memDir, 'index.md');

  if (!fs.existsSync(memDir)) {
    process.stderr.write(`build-index: memory dir not found: ${memDir}\n`);
    process.exit(1);
  }

  if (mode === 'check') runCheck(memDir, indexPath);
  else runWrite(memDir, indexPath);
}

main();
