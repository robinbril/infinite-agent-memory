'use strict';
/**
 * tests/build-index.test.js
 * Tests for scripts/build-index.js
 * Uses Node's built-in test runner (node --test). Zero external deps.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const fs     = require('fs');

const { rmDir, makeMemoryDir, pageFm, run } = require('./helpers.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'build-index.js');

// Helper: run build-index against a specific memory dir
function bi(args, memDir) {
  return run('node', [SCRIPT, ...args, memDir]);
}

let roots = [];
after(() => { for (const r of roots) rmDir(r); });

function fresh(opts) {
  const r = makeMemoryDir(opts);
  roots.push(r);
  return r;
}

// ---------------------------------------------------------------------------

describe('build-index --check', () => {

  it('exits 0 when index is in sync with disk', () => {
    const root = fresh({
      index: '## Entities\n- [alpha](entities/alpha.md): test entity\n',
      files: { 'entities/alpha.md': pageFm('alpha') },
    });
    const { code, stdout } = bi(['--check'], root);
    assert.equal(code, 0, 'exits 0 when in sync');
    assert.ok(stdout.includes('ok'), 'prints ok');
  });

  it('exits 1 and reports orphan when a page is not in index', () => {
    const root = fresh({
      index: '',   // empty index
      files: { 'entities/beta.md': pageFm('beta') },
    });
    const { code, stderr } = bi(['--check'], root);
    assert.equal(code, 1, 'exits 1 on orphan');
    assert.ok(stderr.includes('ORPHAN'), 'reports ORPHAN');
    assert.ok(stderr.includes('entities/beta.md'), 'names the orphan file');
  });

  it('exits 1 and reports dead link when index references missing file', () => {
    const root = fresh({
      index: '## Entities\n- [ghost](entities/ghost.md): phantom\n',
      files: {},  // no actual file on disk
    });
    const { code, stderr } = bi(['--check'], root);
    assert.equal(code, 1, 'exits 1 on dead link');
    assert.ok(stderr.includes('DEAD'), 'reports DEAD');
  });

  it('exits 1 on nonexistent memory dir', () => {
    const { code } = run('node', [SCRIPT, '--check', '/nonexistent/dir/xyz']);
    assert.equal(code, 1, 'exits 1 when dir missing');
  });

  it('exits 0 with empty memory dir and no index', () => {
    // No pages, no index. Nothing to complain about.
    const root = fresh({});
    const { code } = bi(['--check'], root);
    assert.equal(code, 0, 'empty dir is fine');
  });

});

// ---------------------------------------------------------------------------

describe('build-index --write', () => {

  it('adds an orphaned page to the index', () => {
    const root = fresh({
      index: '',
      files: { 'entities/gamma.md': pageFm('gamma') },
    });
    const { code } = bi(['--write'], root);
    assert.equal(code, 0);

    const index = fs.readFileSync(path.join(root, 'index.md'), 'utf8');
    assert.ok(index.includes('entities/gamma.md'), 'orphan added to index');
  });

  it('is idempotent: second --write does not add duplicates', () => {
    const root = fresh({
      index: '',
      files: { 'entities/delta.md': pageFm('delta') },
    });
    bi(['--write'], root);
    const after1 = fs.readFileSync(path.join(root, 'index.md'), 'utf8');
    bi(['--write'], root);
    const after2 = fs.readFileSync(path.join(root, 'index.md'), 'utf8');

    assert.equal(after1, after2, 'second write produces identical index');

    // Confirm no duplicate entries
    const count = (after2.match(/entities\/delta\.md/g) || []).length;
    assert.equal(count, 1, 'delta.md appears exactly once');
  });

  it('preserves handwritten hooks already in the index', () => {
    const handwrittenLine = '- [epsilon](entities/epsilon.md): my custom hook text';
    const root = fresh({
      index: '## Entities\n' + handwrittenLine + '\n',
      files: { 'entities/epsilon.md': pageFm('epsilon') },
    });
    bi(['--write'], root);
    const index = fs.readFileSync(path.join(root, 'index.md'), 'utf8');
    assert.ok(index.includes('my custom hook text'), 'handwritten hook preserved');
  });

  it('adds all four standard section headings even when memory is empty', () => {
    const root = fresh({ index: '' });
    bi(['--write'], root);
    const index = fs.readFileSync(path.join(root, 'index.md'), 'utf8');
    assert.ok(index.includes('## Entities'),   '## Entities present');
    assert.ok(index.includes('## Concepts'),   '## Concepts present');
    assert.ok(index.includes('## Summaries'),  '## Summaries present');
    assert.ok(index.includes('## Sources'),    '## Sources present');
  });

  it('creates index.md when none exists', () => {
    const root = fresh({ files: { 'entities/zeta.md': pageFm('zeta') } });
    // No index.md written
    assert.ok(!fs.existsSync(path.join(root, 'index.md')), 'no index yet');
    bi(['--write'], root);
    assert.ok(fs.existsSync(path.join(root, 'index.md')), 'index.md created');
  });

  it('strips BOM from existing index before updating', () => {
    const bom = '﻿';
    const root = fresh({
      index: bom + '## Entities\n',
      files: { 'entities/theta.md': pageFm('theta') },
    });
    bi(['--write'], root);
    const raw = fs.readFileSync(path.join(root, 'index.md'), 'utf8');
    assert.ok(!raw.startsWith('﻿'), 'BOM stripped from output');
    assert.ok(raw.includes('entities/theta.md'), 'page still added');
  });

  // REGRESSION: CRLF line endings must not cause duplicate section headings.
  it('CRLF regression: does not duplicate sections when index has CRLF line endings', () => {
    // This is the exact bug scenario: index written with \r\n, parseIndexSections
    // used to treat "## Sources\r" as not matching /^##\s+/, so sections were lost
    // and then re-added on the next --write, causing duplicates.
    const crlfIndex = [
      '## Entities',
      '- [iota](entities/iota.md): existing entity',
      '',
      '## Sources',
      '- [raw](sources/raw.md): raw source',
    ].join('\r\n') + '\r\n';

    const root = fresh({
      index: crlfIndex,
      files: {
        'entities/iota.md': pageFm('iota'),
        'sources/raw.md':   '---\nname: raw\ningested: 2026-01-01\n---\nRaw source content.\n',
      },
    });

    bi(['--write'], root);
    const after1 = fs.readFileSync(path.join(root, 'index.md'), 'utf8');
    bi(['--write'], root);
    const after2 = fs.readFileSync(path.join(root, 'index.md'), 'utf8');

    assert.equal(after1, after2, 'CRLF index: second write is identical to first');

    // Count occurrences of each section heading
    const entCount = (after2.match(/^## Entities/gm) || []).length;
    const srcCount = (after2.match(/^## Sources/gm) || []).length;
    assert.equal(entCount, 1, '## Entities appears exactly once after CRLF input');
    assert.equal(srcCount, 1, '## Sources appears exactly once after CRLF input');

    // No duplicate page entries
    const iotaCount = (after2.match(/entities\/iota\.md/g) || []).length;
    assert.equal(iotaCount, 1, 'iota.md not duplicated');
  });

  it('handles multiple pages across multiple dirs', () => {
    const root = fresh({
      index: '',
      files: {
        'entities/kappa.md':  pageFm('kappa'),
        'concepts/lambda.md': pageFm('lambda', 'concept'),
        'summaries/mu.md':    pageFm('mu',     'summary'),
        'sources/nu.md':      '---\nname: nu\ningested: 2026-01-01\n---\nContent.\n',
      },
    });
    bi(['--write'], root);
    const index = fs.readFileSync(path.join(root, 'index.md'), 'utf8');
    assert.ok(index.includes('entities/kappa.md'),   'entity kappa in index');
    assert.ok(index.includes('concepts/lambda.md'),  'concept lambda in index');
    assert.ok(index.includes('summaries/mu.md'),     'summary mu in index');
    assert.ok(index.includes('sources/nu.md'),       'source nu in index');
  });

});

// ---------------------------------------------------------------------------

describe('build-index --check after --write', () => {

  it('--check passes after --write (round-trip)', () => {
    const root = fresh({
      index: '',
      files: {
        'entities/xi.md':   pageFm('xi'),
        'concepts/pi.md':   pageFm('pi', 'concept'),
      },
    });
    const w = bi(['--write'], root);
    assert.equal(w.code, 0, '--write succeeds');

    const c = bi(['--check'], root);
    assert.equal(c.code, 0, '--check passes after --write');
  });

});
