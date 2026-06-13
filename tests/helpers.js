'use strict';
/**
 * Shared test helpers: temp-dir lifecycle + fixture builders.
 * Zero external deps; uses only Node built-ins.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

/**
 * Create a temp directory under os.tmpdir() with a unique suffix.
 * Returns its absolute path.
 */
function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

/**
 * Recursively remove a directory (safe no-op if it doesn't exist).
 */
function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

/**
 * Write a file, creating parent directories as needed.
 * content may be a string or Buffer.
 */
function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

/**
 * Build a minimal but realistic memory directory with the standard layout:
 *   <root>/entities/
 *   <root>/concepts/
 *   <root>/summaries/
 *   <root>/sources/
 *
 * Optionally writes an initial index.md (string) and a map of extra files
 * in the shape { 'entities/foo.md': '...content...' }.
 *
 * Returns the root path.
 */
function makeMemoryDir(opts) {
  opts = opts || {};
  const root = makeTmpDir('mem');
  for (const sub of ['entities', 'concepts', 'summaries', 'sources']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  if (opts.index !== undefined) {
    fs.writeFileSync(path.join(root, 'index.md'), opts.index);
  }
  if (opts.files) {
    for (const [rel, content] of Object.entries(opts.files)) {
      writeFile(path.join(root, rel), content);
    }
  }
  return root;
}

/**
 * Minimal valid memory page frontmatter + body.
 */
function pageFm(name, type, extra) {
  extra = extra || '';
  return [
    '---',
    `name: ${name}`,
    `type: ${type || 'entity'}`,
    'sources: []',
    'links: []',
    'updated: 2026-01-01',
    '---',
    extra || `## What\nThis is the ${name} page.\n\n## Key facts\n- Fact about ${name} (source: test)`,
  ].join('\n') + '\n';
}

/**
 * Write a synthetic JSONL transcript to a temp file.
 * turns: array of { type: 'user'|'assistant', content }
 *   content may be a string, or an array of content blocks.
 * Returns the file path.
 */
function makeTranscript(turns, dir) {
  dir = dir || os.tmpdir();
  const file = path.join(dir, 'test-transcript-' + process.pid + '-' + Date.now() + '.jsonl');
  const lines = turns.map(t => JSON.stringify({
    type: t.type,
    message: { content: t.content }
  }));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/**
 * Spawn a child process and collect stdout/stderr/exitCode.
 * Returns a Promise<{ stdout, stderr, code }>.
 */
function run(cmd, args, opts) {
  const { spawnSync } = require('child_process');
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: Object.assign({}, process.env, opts && opts.env),
    input: opts && opts.stdin,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code:   result.status,
  };
}

module.exports = { makeTmpDir, rmDir, writeFile, makeMemoryDir, pageFm, makeTranscript, run };
