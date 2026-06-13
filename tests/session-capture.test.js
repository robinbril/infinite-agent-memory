'use strict';
/**
 * tests/session-capture.test.js
 * Tests for hooks/session-capture.js
 * Uses Node's built-in test runner (node --test). Zero external deps.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

const { makeTmpDir, rmDir, makeMemoryDir, makeTranscript, run } = require('./helpers.js');

const SCRIPT = path.join(__dirname, '..', 'hooks', 'session-capture.js');

const SUBSTANTIAL_BYTES = 40 * 1024; // must match the script constant

let roots = [];
let tmpDirs = [];

after(() => {
  for (const r of roots)   rmDir(r);
  for (const d of tmpDirs) rmDir(d);
});

function fresh(opts) {
  const r = makeMemoryDir(opts);
  roots.push(r);
  return r;
}

function freshTmp() {
  const d = makeTmpDir('capture');
  tmpDirs.push(d);
  return d;
}

/**
 * Write a transcript file of a given byte size.
 * Returns the file path.
 */
function makeTranscriptOfSize(dir, bytes) {
  // Build a valid JSONL line big enough to reach the target
  const line = JSON.stringify({
    type: 'user',
    message: { content: 'x'.repeat(Math.max(bytes - 200, 100)) },
  });
  const p = path.join(dir, 'transcript-' + Date.now() + '.jsonl');
  fs.writeFileSync(p, line + '\n');
  return p;
}

/**
 * Run session-capture with the given JSON payload on stdin.
 */
function capture(payload, memDir) {
  return run('node', [SCRIPT], {
    stdin: JSON.stringify(payload),
    env: { AGENT_MEMORY_DIR: memDir },
  });
}

/**
 * Read the queue file and parse its entries.
 */
function readQueue(memDir) {
  const qp = path.join(memDir, '_capture-queue.jsonl');
  try {
    return fs.readFileSync(qp, 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch (_) { return []; }
}

// ---------------------------------------------------------------------------

describe('session-capture: substantial session', () => {

  it('queues a session that exceeds the size threshold', () => {
    const memDir = fresh({});
    const tmpDir = freshTmp();
    const transcript = makeTranscriptOfSize(tmpDir, SUBSTANTIAL_BYTES + 5000);

    capture({ transcript_path: transcript, session_id: 'sub-001', cwd: '/project' }, memDir);

    const queue = readQueue(memDir);
    assert.equal(queue.length, 1, 'one entry in queue');
    assert.equal(queue[0].sessionId, 'sub-001');
    assert.ok(queue[0].sizeKB > 0, 'sizeKB recorded');
    assert.ok(queue[0].ts, 'timestamp present');
  });

  it('extracts topic from the first real user message', () => {
    const memDir = fresh({});
    const tmpDir = freshTmp();

    // Build a transcript with a real first user message
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'Please refactor the auth module.' } }),
      // pad to substantial size
      JSON.stringify({ type: 'user', message: { content: 'x'.repeat(SUBSTANTIAL_BYTES) } }),
    ];
    const p = path.join(tmpDir, 'topic.jsonl');
    fs.writeFileSync(p, lines.join('\n') + '\n');

    capture({ transcript_path: p, session_id: 'topic-001', cwd: '/repo' }, memDir);

    const queue = readQueue(memDir);
    assert.equal(queue.length, 1);
    assert.ok(queue[0].topic.includes('refactor the auth module'), 'topic extracted correctly');
  });

  it('does not duplicate a session already in the queue', () => {
    const memDir = fresh({});
    const tmpDir = freshTmp();
    const transcript = makeTranscriptOfSize(tmpDir, SUBSTANTIAL_BYTES + 1000);

    capture({ transcript_path: transcript, session_id: 'dup-001' }, memDir);
    capture({ transcript_path: transcript, session_id: 'dup-001' }, memDir);

    const queue = readQueue(memDir);
    assert.equal(queue.length, 1, 'duplicate session not added twice');
  });

});

// ---------------------------------------------------------------------------

describe('session-capture: small session', () => {

  it('does NOT queue a session below the size threshold', () => {
    const memDir = fresh({});
    const tmpDir = freshTmp();
    const transcript = makeTranscriptOfSize(tmpDir, 1000); // way under 40 KB

    capture({ transcript_path: transcript, session_id: 'small-001' }, memDir);

    const queue = readQueue(memDir);
    assert.equal(queue.length, 0, 'small session not queued');
  });

  it('does NOT queue when transcript is missing', () => {
    const memDir = fresh({});
    capture({ transcript_path: '/no/such/file.jsonl', session_id: 'missing-001' }, memDir);
    assert.equal(readQueue(memDir).length, 0, 'missing transcript not queued');
  });

});

// ---------------------------------------------------------------------------

describe('session-capture: wroteToWiki skip', () => {

  it('skips queuing when the session wrote into the memory directory', () => {
    const memDir = fresh({});
    const tmpDir = freshTmp();

    // Build a transcript where an assistant turn uses Write into the memory dir
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'Write',
            input: { file_path: path.join(memDir, 'entities', 'test.md').replace(/\\/g, '/') },
          }],
        },
      }),
      // pad to substantial size
      JSON.stringify({ type: 'user', message: { content: 'x'.repeat(SUBSTANTIAL_BYTES) } }),
    ];
    const p = path.join(tmpDir, 'wrote.jsonl');
    fs.writeFileSync(p, lines.join('\n') + '\n');

    capture({ transcript_path: p, session_id: 'wrote-001', cwd: '/project' }, memDir);

    const queue = readQueue(memDir);
    assert.equal(queue.length, 0, 'session that wrote to memory is not queued');
  });

  it('also skips for Edit tool writes into the memory directory', () => {
    const memDir = fresh({});
    const tmpDir = freshTmp();

    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            name: 'Edit',
            input: { file_path: path.join(memDir, 'concepts', 'foo.md').replace(/\\/g, '/') },
          }],
        },
      }),
      JSON.stringify({ type: 'user', message: { content: 'x'.repeat(SUBSTANTIAL_BYTES) } }),
    ];
    const p = path.join(tmpDir, 'edit.jsonl');
    fs.writeFileSync(p, lines.join('\n') + '\n');

    capture({ transcript_path: p, session_id: 'edit-001', cwd: '/project' }, memDir);

    assert.equal(readQueue(memDir).length, 0, 'Edit to memory dir skips queue');
  });

});

// ---------------------------------------------------------------------------

describe('session-capture: edge cases', () => {

  it('always exits 0', () => {
    const memDir = fresh({});
    const { code } = capture({ transcript_path: '', session_id: '' }, memDir);
    assert.equal(code, 0);
  });

  it('exits 0 when memory dir does not exist', () => {
    const { code } = capture(
      { transcript_path: '/no/file.jsonl', session_id: 'x' },
      '/nonexistent/memory/dir/abc'
    );
    assert.equal(code, 0);
  });

  it('exits 0 with malformed stdin', () => {
    const { code } = run('node', [SCRIPT], {
      stdin: 'not json <<<',
      env: { AGENT_MEMORY_DIR: makeMemoryDir({}) },
    });
    assert.equal(code, 0);
  });

  it('skips slash-command as topic and finds next real message', () => {
    const memDir = fresh({});
    const tmpDir = freshTmp();

    const lines = [
      JSON.stringify({ type: 'user', message: { content: '/help' } }),
      JSON.stringify({ type: 'user', message: { content: 'Build me a landing page.' } }),
      JSON.stringify({ type: 'user', message: { content: 'x'.repeat(SUBSTANTIAL_BYTES) } }),
    ];
    const p = path.join(tmpDir, 'slash.jsonl');
    fs.writeFileSync(p, lines.join('\n') + '\n');

    capture({ transcript_path: p, session_id: 'slash-001' }, memDir);

    const queue = readQueue(memDir);
    assert.equal(queue.length, 1);
    assert.ok(queue[0].topic.includes('Build me a landing page'), 'slash command skipped as topic');
  });

});
