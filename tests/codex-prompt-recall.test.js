'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { makeMemoryDir, pageFm, rmDir, run, writeFile } = require('./helpers.js');

const ADAPTER = path.join(__dirname, '..', 'integrations', 'codex-prompt-recall-adapter.js');
const NOTE = 'concepts/atlas-gateway.md';
const QUESTION = 'How does the Atlas gateway reconnect during upstream drain?';

function setup(t) {
  const memory = makeMemoryDir({ files: {
    [NOTE]: pageFm('atlas-gateway', 'concept', '## What\nAtlas gateway reconnect during upstream drain uses QUIC.'),
  } });
  t.after(() => rmDir(memory));
  const transcript = path.join(memory, 'fixture.jsonl');
  const event = { type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: QUESTION }] } };
  writeFile(transcript, `${JSON.stringify(event)}\n`);

  function recall(payload) {
    const result = run(process.execPath, [ADAPTER], {
      stdin: JSON.stringify(payload),
      env: { AGENT_MEMORY_DIR: memory, AGENT_MEMORY_RECALL: '1', AGENT_MEMORY_DENSE: '0' },
    });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  }
  return { recall, transcript };
}

function assertContext(text) {
  const result = JSON.parse(text);
  assert.equal(result.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.ok(result.hookSpecificOutput.additionalContext.includes(NOTE));
  assert.ok(result.hookSpecificOutput.additionalContext.includes('uses QUIC'));
}

test('uses the current Codex prompt with no transcript', t => {
  const { recall } = setup(t);
  assertContext(recall({ prompt: QUESTION, transcript_path: null, session_id: 'native' }));
});

test('an unrelated or empty current prompt cannot revive a prior transcript prompt', t => {
  const { recall, transcript } = setup(t);
  assert.equal(recall({ prompt: 'What is the weather forecast tomorrow?', transcript_path: transcript, session_id: 'current' }), '');
  assert.equal(recall({ prompt: '', transcript_path: transcript, session_id: 'empty' }), '');
  assert.equal(recall({ prompt: null, transcript_path: transcript, session_id: 'invalid' }), '');
});

test('keeps transcript fallback for clients that omit the prompt field', t => {
  const { recall, transcript } = setup(t);
  assertContext(recall({ transcript_path: transcript, session_id: 'legacy' }));
});
