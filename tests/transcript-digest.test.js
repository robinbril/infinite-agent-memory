'use strict';
/**
 * tests/transcript-digest.test.js
 * Tests for scripts/transcript-digest.js
 * Uses Node's built-in test runner (node --test). Zero external deps.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const fs     = require('fs');

const { makeTmpDir, rmDir, makeTranscript, run } = require('./helpers.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'transcript-digest.js');

let tmpDir;
before(() => { tmpDir = makeTmpDir('digest'); });
after(()  => { rmDir(tmpDir); });

describe('transcript-digest', () => {

  it('drops tool_result blocks, keeps user/assistant text', () => {
    const turns = [
      // user turn with plain text
      { type: 'user', content: 'Please summarise the codebase.' },
      // assistant turn with mixed content: text + tool_use
      { type: 'assistant', content: [
        { type: 'text', text: 'Sure, let me look at the files.' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/foo.js' } },
      ]},
      // user turn that is a tool_result envelope (should be dropped as noise)
      { type: 'user', content: '<tool_result>some output</tool_result>' },
      // another real assistant turn
      { type: 'assistant', content: 'I found three modules.' },
    ];

    const file = makeTranscript(turns, tmpDir);
    const { stdout, code } = run('node', [SCRIPT, file]);

    assert.equal(code, 0, 'exits 0');

    // user text present
    assert.ok(stdout.includes('Please summarise'), 'user text preserved');
    // assistant prose present
    assert.ok(stdout.includes('Sure, let me look'), 'assistant text preserved');
    assert.ok(stdout.includes('I found three modules'), 'second assistant turn present');
    // tool_use appears as a one-liner marker
    assert.ok(stdout.includes('[tool: Read'), 'tool_use collapsed to marker');
    // tool_result envelope is noise-filtered
    assert.ok(!stdout.includes('<tool_result>'), 'tool_result envelope dropped');
    assert.ok(!stdout.includes('some output'), 'tool output content dropped');
  });

  it('enforces per-turn char cap', () => {
    const longText = 'x'.repeat(10000);
    const turns = [
      { type: 'user', content: longText },
    ];
    const file = makeTranscript(turns, tmpDir);
    const { stdout, code } = run('node', [SCRIPT, file]);

    assert.equal(code, 0);
    // The block should be capped and include the truncation marker
    assert.ok(stdout.includes('...[truncated]'), 'long turn is truncated');
    // Output should not contain the full 10 000 chars
    assert.ok(stdout.length < 8000, 'output is shorter than raw input');
  });

  it('enforces total digest char cap', () => {
    // Build many large turns that would exceed MAX_DIGEST_CHARS (90000)
    const turns = [];
    for (let i = 0; i < 50; i++) {
      turns.push({ type: 'user',      content: 'Tell me about item ' + i + '. ' + 'a'.repeat(2000) });
      turns.push({ type: 'assistant', content: 'Item ' + i + ' is important. ' + 'b'.repeat(2000) });
    }
    const file = makeTranscript(turns, tmpDir);
    const { stdout, code } = run('node', [SCRIPT, file]);

    assert.equal(code, 0);
    assert.ok(stdout.includes('...[digest truncated'), 'digest truncation marker present');
    assert.ok(stdout.length < 120000, 'digest does not blow past the cap');
  });

  it('handles empty file gracefully', () => {
    const file = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(file, '');
    const { stdout, code } = run('node', [SCRIPT, file]);
    assert.equal(code, 0);
    assert.equal(stdout, '', 'empty input yields empty output');
  });

  it('handles missing file gracefully (exits 0, no output)', () => {
    const { stdout, stderr, code } = run('node', [SCRIPT, '/nonexistent/path/transcript.jsonl']);
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  it('handles no argument gracefully (exits 0)', () => {
    const { stdout, code } = run('node', [SCRIPT]);
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

  it('skips Caveat: lines as noise', () => {
    const turns = [
      { type: 'user', content: 'Caveat: this is a system notice' },
      { type: 'user', content: 'Real user question here.' },
    ];
    const file = makeTranscript(turns, tmpDir);
    const { stdout } = run('node', [SCRIPT, file]);
    assert.ok(!stdout.includes('Caveat:'), 'Caveat: line filtered');
    assert.ok(stdout.includes('Real user question'), 'real turn kept');
  });

  it('skips [Request interrupted lines as noise', () => {
    const turns = [
      { type: 'user', content: '[Request interrupted by user]' },
      { type: 'user', content: 'Retry: what time is it?' },
    ];
    const file = makeTranscript(turns, tmpDir);
    const { stdout } = run('node', [SCRIPT, file]);
    assert.ok(!stdout.includes('Request interrupted'), 'interrupted marker filtered');
    assert.ok(stdout.includes('Retry: what time'), 'real turn kept');
  });

  it('emits ## User / ## Assistant section headers', () => {
    const turns = [
      { type: 'user',      content: 'Question.' },
      { type: 'assistant', content: 'Answer.' },
    ];
    const file = makeTranscript(turns, tmpDir);
    const { stdout } = run('node', [SCRIPT, file]);
    assert.ok(stdout.includes('## User'),      '## User header present');
    assert.ok(stdout.includes('## Assistant'), '## Assistant header present');
  });

  it('includes tool_use file_path in the marker', () => {
    const turns = [
      { type: 'assistant', content: [
        { type: 'tool_use', name: 'Write', input: { file_path: '/project/src/main.js' } },
      ]},
    ];
    const file = makeTranscript(turns, tmpDir);
    const { stdout } = run('node', [SCRIPT, file]);
    assert.ok(stdout.includes('/project/src/main.js'), 'file_path in tool marker');
  });
});
