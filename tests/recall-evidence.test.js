'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { makeMemoryDir, rmDir, pageFm, run, writeFile } = require('./helpers.js');

const SCRIPT = path.join(__dirname, '..', 'hooks', 'prompt-recall.js');
const PAGE = 'concepts/atlas-gateway.md';
const QUESTION = 'How does the Atlas gateway reconnect during upstream drain?';
const FILLER = Array.from({ length: 36 }, (_, i) =>
  `- Inventory review ${i} recorded standard deployment information (source: inventory-${i}).`).join('\n');

function fixture(t, body, files) {
  const memory = makeMemoryDir({ files: { [PAGE]: pageFm('atlas-gateway', 'concept', body), ...files } });
  t.after(() => rmDir(memory));
  return memory;
}

function recall(memory, prompt, sessionId = 'fresh') {
  const result = run(process.execPath, [SCRIPT], {
    stdin: JSON.stringify({ prompt, session_id: sessionId }),
    env: { AGENT_MEMORY_DIR: memory, AGENT_MEMORY_RECALL: '1', AGENT_MEMORY_DENSE: '0' },
  });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}

test('injects a matching fact beyond the cached excerpt with its source', t => {
  const evidence = '- The Atlas gateway reconnect uses QUIC during upstream drain. (source: reconnect-check)';
  const memory = fixture(t, `## What\nAtlas gateway reference.\n\n## Key facts\n${FILLER}\n${evidence}`);
  const output = recall(memory, QUESTION);
  assert.ok(output.includes(`<memory-recall source="${PAGE}">`));
  assert.ok(output.includes(evidence));
});

test('keeps a nested decision, its qualifier and source together', t => {
  const evidence = '- The Atlas gateway must reconnect only after upstream drain completes.\n\n' +
    '  Do not enable early reconnect on regional replicas. (source: decision-42)';
  const memory = fixture(t, '## What\nAtlas gateway reference.\n\n## Key facts\n' + FILLER +
    `\n\n## Decisions\n### Regional replicas\n${evidence}`);
  const output = recall(memory, QUESTION);
  assert.ok(output.includes(`<memory-recall source="${PAGE}">`));
  assert.ok(output.includes(`## Decisions\n### Regional replicas\n${evidence}`));
});

test('CRLF and LF pages surface the same evidence', t => {
  const early = '- Atlas gateway regional reference.\n  A reviewed overview paragraph.';
  const late = '- Atlas gateway regional verification is required. (source: late-regional)';
  const body = `## What\nAtlas gateway reference.\n\n## Key facts\n${early}\n${FILLER}\n${late}`;
  const query = 'How does Atlas gateway regional work?';
  for (const eol of ['\n', '\r\n']) {
    const memory = fixture(t, body);
    const file = path.join(memory, PAGE);
    if (eol === '\r\n') fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, eol));
    const output = recall(memory, query);
    assert.ok(output.includes(late), JSON.stringify(eol));
    assert.equal(output.split('Atlas gateway regional reference.').length - 1, 1);
  }
});

test('keeps the normal excerpt when evidence outside it lacks a strong prompt match', t => {
  const memory = fixture(t, '## What\nAtlas gateway reference.\n\n## Key facts\n- Config uses a local file.\n' +
    '\n## Decisions\n- Overnight maintenance windows. (source: unrelated-decision)');
  const output = recall(memory, 'Describe the Atlas gateway config');
  assert.ok(output.includes('- Config uses a local file.'));
  assert.ok(!output.includes('unrelated-decision'));
  assert.equal(recall(memory, 'What is the weather forecast tomorrow?', 'unrelated'), '');
});

test('repeating one subject word does not satisfy the topicality gate', t => {
  const memory = fixture(t, '## What\nAtlas gateway reference.');
  assert.equal(recall(memory, 'Atlas atlas atlas atlas'), '');
});

test('a higher-scoring off-topic page does not hide an eligible result', t => {
  const prompt = 'Atlas gateway reconnect upstream drain canary failover schedule rebalance alert';
  const offTopic = `## Key facts\n${(`- ${prompt}\n`).repeat(24)}`;
  const memory = fixture(t, '## What\nAtlas gateway reconnect and upstream drain.\n', {
    'concepts/ops-runbook.md': pageFm('ops-runbook', 'concept', offTopic),
    'concepts/database-maintenance.md': pageFm('database-maintenance', 'concept'),
  });

  const output = recall(memory, prompt);
  assert.ok(output.includes(`source="${PAGE}"`));
  assert.ok(!output.includes('source="concepts/ops-runbook.md"'));
});

test('does not inject an edited or missing page from a warm cache', t => {
  const body = '## What\nAtlas gateway reconnect during upstream drain is documented here.\n\n' +
    '## Key facts\n- The Atlas gateway reconnect is active. (source: old-page)';
  const memory = fixture(t, body);
  assert.ok(recall(memory, QUESTION, 'before').includes('old-page'));

  const file = path.join(memory, PAGE);
  fs.renameSync(file, `${file}.old`);
  assert.equal(recall(memory, QUESTION, 'missing'), '');
  fs.writeFileSync(file, 'Replaced with unrelated content.');
  assert.equal(recall(memory, QUESTION, 'changed'), '');
});

test('rebuilds the index on the next query after detecting a changed page', t => {
  const memory = fixture(t, '## Key facts\n- The Atlas gateway reconnect during upstream drain. (source: old)');
  assert.ok(recall(memory, QUESTION, 'before').includes('(source: old)'));
  const current = '- The Atlas gateway reconnect after an upstream drain now requires two confirmations. (source: current)';
  fs.writeFileSync(path.join(memory, PAGE), pageFm('atlas-gateway', 'concept', `## Key facts\n${current}`));

  assert.equal(recall(memory, QUESTION, 'changed'), '');
  const refreshed = recall(memory, QUESTION, 'refreshed');
  assert.ok(refreshed.includes(current));
  assert.ok(!refreshed.includes('(source: old)'));
});

test('uses the bounded overview for a page above the on-demand read limit', t => {
  const overview = '## What\nAtlas gateway reference for reconnect during upstream drain.';
  const large = `${overview}\n\n## Key facts\n${FILLER.repeat(30)}\n` +
    '\n## Decisions\n- The Atlas gateway reconnect during upstream drain requires a large-page test. (source: over-limit)';
  const output = recall(fixture(t, large), QUESTION);
  assert.ok(output.includes(overview));
  assert.ok(!output.includes('(source: over-limit)'));
});

test('escapes markup in recalled text and file references', t => {
  const page = 'entities/atlas&gateway.md';
  const memory = makeMemoryDir({ files: {
    [page]: pageFm('atlas-gateway', 'entity', '## What\nAtlas gateway reconnect during upstream drain.\n\n' +
      '## Key facts\n- Label the Atlas gateway reconnect as <example> & quote it. (source: label-check)'),
  } });
  t.after(() => rmDir(memory));
  const output = recall(memory, QUESTION);
  assert.ok(output.includes('source="entities/atlas&amp;gateway.md"'));
  assert.ok(output.includes('&lt;example&gt; &amp; quote it.'));
  assert.ok(!output.includes('<example>'));
});

test('recall audit attributes escaped paths to the original page', t => {
  const page = 'concepts/atlas&gateway.md';
  const body = '## What\nAtlas gateway reference for reconnect during upstream drain.';
  const memory = makeMemoryDir({ files: { [page]: pageFm('atlas-gateway', 'concept', body) } });
  t.after(() => rmDir(memory));
  const output = recall(memory, QUESTION);
  const projects = path.join(memory, 'projects');
  const turns = [{ type: 'user', content: output }, { type: 'assistant', content: `Read ${page}` }];
  writeFile(path.join(projects, 'fixture', 'session.jsonl'), turns.map(turn => JSON.stringify(turn)).join('\n'));
  const legacyPage = 'concepts/legacy&amp;literal.md';
  const legacy = [
    { type: 'user', content: `<memory-recall source="${legacyPage}">\nPrevious content\n</memory-recall>` },
    { type: 'assistant', content: `Read ${legacyPage}` },
  ];
  writeFile(path.join(projects, 'fixture', 'old-session.jsonl'), legacy.map(turn => JSON.stringify(turn)).join('\n'));

  const audit = path.join(__dirname, '..', 'scripts', 'recall-audit.js');
  const result = run(process.execPath, [audit], { env: { CLAUDE_PROJECTS_DIR: projects } });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /total: 2 injections, 2 used/);
  assert.ok(result.stdout.includes(page));
  assert.ok(result.stdout.includes(legacyPage));
});

test('keeps the entire two-page payload inside 2,800 characters', t => {
  const body = `## What\nAtlas gateway reconnect during upstream drain.\n\n## Key facts\n${FILLER}`;
  const memory = fixture(t, body, { 'entities/gateway-atlas.md': pageFm('gateway-atlas', 'entity', body) });
  const output = recall(memory, QUESTION);
  assert.equal((output.match(/<memory-recall source=/g) || []).length, 2);
  assert.ok(output.length <= 2800, `payload was ${output.length} characters`);
});
