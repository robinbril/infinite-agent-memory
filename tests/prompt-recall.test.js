'use strict';
/**
 * tests/prompt-recall.test.js
 * Tests for hooks/prompt-recall.js
 * Uses Node's built-in test runner (node --test). Zero external deps.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const fs     = require('fs');

const { rmDir, makeMemoryDir, pageFm, run } = require('./helpers.js');

const SCRIPT = path.join(__dirname, '..', 'hooks', 'prompt-recall.js');

let roots = [];
after(() => { for (const r of roots) rmDir(r); });

function fresh(opts) {
  const r = makeMemoryDir(opts);
  roots.push(r);
  return r;
}

/**
 * Run prompt-recall with a given JSON payload on stdin.
 * Sets AGENT_MEMORY_DIR to the provided memDir.
 */
function recall(payload, memDir) {
  return run('node', [SCRIPT], {
    stdin: JSON.stringify(payload),
    env: { AGENT_MEMORY_DIR: memDir },
  });
}

// ---------------------------------------------------------------------------
// Shared memory dir with a recognisable topic page used in multiple tests.
// ---------------------------------------------------------------------------

let sharedRoot;
before(() => {
  sharedRoot = makeMemoryDir({
    files: {
      // A page that is clearly about "BM25 retrieval algorithm"
      'concepts/bm25-retrieval.md': [
        '---',
        'name: bm25-retrieval',
        'type: concept',
        'sources: []',
        'links: []',
        'updated: 2026-01-01',
        '---',
        '## What',
        'BM25 is a ranking function used by search engines to estimate relevance of documents to queries.',
        '',
        '## Key facts',
        '- BM25 stands for Best Match 25 (source: test)',
        '- Uses term frequency and inverse document frequency (source: test)',
        '- Parameters k1 and b control saturation and length normalization (source: test)',
      ].join('\n') + '\n',

      // A second page on an unrelated topic
      'entities/acme-corp.md': [
        '---',
        'name: acme-corp',
        'type: entity',
        'sources: []',
        'links: []',
        'updated: 2026-01-01',
        '---',
        '## What',
        'Acme Corp is a fictional company used in test fixtures.',
        '',
        '## Key facts',
        '- Founded in 1950 (source: test)',
        '- Sells cartoon anvils and explosives (source: test)',
      ].join('\n') + '\n',
    },
  });
  roots.push(sharedRoot);
});

// ---------------------------------------------------------------------------

describe('prompt-recall gate 1: trivial / slash-command prompts', () => {

  it('injects nothing for a trivial short prompt', () => {
    const { stdout, code } = recall({ prompt: 'hi', session_id: 'gate1a' }, sharedRoot);
    assert.equal(code, 0);
    assert.equal(stdout, '', 'no injection for short prompt');
  });

  it('injects nothing for a slash-command prompt', () => {
    const { stdout, code } = recall({ prompt: '/help', session_id: 'gate1b' }, sharedRoot);
    assert.equal(code, 0);
    assert.equal(stdout, '', 'no injection for slash command');
  });

  it('injects nothing for an empty prompt', () => {
    const { stdout, code } = recall({ prompt: '', session_id: 'gate1c' }, sharedRoot);
    assert.equal(code, 0);
    assert.equal(stdout, '');
  });

});

// ---------------------------------------------------------------------------

describe('prompt-recall gate 2+3: score threshold + on-topic', () => {

  it('injects the relevant page for an on-topic BM25 prompt', () => {
    // Include 'retrieval' so the prompt matches both title tokens (bm25 + retrieval),
    // satisfying the onTopic gate (titleOverlap >= 2).
    const { stdout, code } = recall({
      prompt: 'How does BM25 retrieval ranking work with term frequency and inverse document frequency?',
      session_id: 'ontopic-' + Date.now(),
    }, sharedRoot);
    assert.equal(code, 0);
    assert.ok(stdout.includes('memory-recall'), 'memory-recall block injected');
    assert.ok(stdout.includes('bm25-retrieval'), 'correct page recalled');
  });

  it('injects nothing for an off-topic prompt', () => {
    // A prompt about weather that shares no meaningful tokens with any page
    const { stdout, code } = recall({
      prompt: 'What is the weather forecast for Amsterdam tomorrow afternoon?',
      session_id: 'offtopic-' + Date.now(),
    }, sharedRoot);
    assert.equal(code, 0);
    assert.equal(stdout, '', 'no injection for off-topic prompt');
  });

  it('injects nothing when memory dir does not exist', () => {
    const { stdout, code } = recall(
      { prompt: 'Tell me about BM25 ranking algorithms and term frequency', session_id: 's1' },
      '/nonexistent/memory/dir/xyz'
    );
    assert.equal(code, 0);
    assert.equal(stdout, '', 'no injection when memDir absent');
  });

  it('exits 0 even with malformed stdin', () => {
    const { code } = run('node', [SCRIPT], {
      stdin: 'not valid json at all <<<',
      env: { AGENT_MEMORY_DIR: sharedRoot },
    });
    assert.equal(code, 0, 'always exits 0');
  });

  it('exits 0 with no stdin', () => {
    const { code } = run('node', [SCRIPT], {
      stdin: '',
      env: { AGENT_MEMORY_DIR: sharedRoot },
    });
    assert.equal(code, 0);
  });

});

// ---------------------------------------------------------------------------

describe('prompt-recall per-session dedup', () => {

  it('does not re-inject the same page within REINJECT_AFTER prompts', () => {
    // We need a fresh memDir so state is isolated, but it still needs pages.
    const dedupRoot = makeMemoryDir({
      files: {
        'concepts/bm25-retrieval.md': [
          '---',
          'name: bm25-retrieval',
          'type: concept',
          'sources: []',
          'links: []',
          'updated: 2026-01-01',
          '---',
          '## What',
          'BM25 retrieval is a ranking function used by search engines for document relevance.',
          '',
          '## Key facts',
          '- BM25 retrieval uses term frequency and inverse document frequency (source: test)',
          '- The retrieval model scores and ranks documents against queries (source: test)',
        ].join('\n') + '\n',
      },
    });
    roots.push(dedupRoot);

    const sessionId = 'dedup-' + Date.now();
    // Include 'retrieval' so both title tokens (bm25 + retrieval) match the onTopic gate.
    const ontopicPrompt = 'Explain BM25 retrieval term frequency and inverse document frequency ranking';

    // First call: should inject
    const first = recall({ prompt: ontopicPrompt, session_id: sessionId }, dedupRoot);
    assert.ok(first.stdout.includes('memory-recall'), 'first call injects');

    // Second call with same session: should NOT inject again (dedup)
    const second = recall({ prompt: ontopicPrompt, session_id: sessionId }, dedupRoot);
    assert.equal(second.stdout, '', 'second call deduped within session');
  });

  it('injects again for a different session', () => {
    const { stdout } = recall({
      prompt: 'Explain BM25 retrieval term frequency inverse document frequency ranking',
      session_id: 'fresh-session-' + Date.now() + '-' + Math.random(),
    }, sharedRoot);
    assert.ok(stdout.includes('memory-recall'), 'fresh session injects');
  });

});
