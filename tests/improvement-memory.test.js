'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { makeTmpDir, rmDir, run, writeFile } = require('./helpers.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'improvement-memory.js');
const PROBLEM = 'premature-completion';
const PROPOSAL = {
  diagnosis: 'The harness can finish before it verifies the deliverable.',
  change: 'Require a successful verification command before completion.',
  rationale: 'This can catch claims made without executing the verifier.',
  prediction: 'Both missing-verification fixtures will pass.',
  context: { model: 'policy-a', benchmark: 'completion-fixtures', split: 'dev', revision: 'candidate-a' },
};
const OUTCOME = {
  observed: 'One fixture passed. The other failed after a timeout.',
  evidence: 'fixture-run-01.txt',
  predictionStatus: 'partially-met',
  decision: 'accepted',
};

function fixture(t) {
  const root = makeTmpDir('improvement-memory');
  t.after(() => rmDir(root));
  const env = { AGENT_MEMORY_DIR: path.join(root, 'memory') };
  function input(name, data) {
    const file = path.join(root, name + '.json');
    writeFile(file, JSON.stringify(data));
    return file;
  }
  const cli = (...args) => run(process.execPath, [SCRIPT, ...args], { env });
  function ok(...args) {
    const result = cli(...args);
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  }
  const stored = name => path.join(env.AGENT_MEMORY_DIR, '_improvements', PROBLEM, name);
  return { cli, ok, input, env, stored };
}

test('exposes a prediction before evaluation and records the outcome separately', t => {
  const { ok, input } = fixture(t);
  assert.deepEqual(JSON.parse(ok('show')), []);
  ok('plan', PROBLEM, 'first', input('plan', PROPOSAL));
  assert.deepEqual(JSON.parse(ok('show')), [PROBLEM]);

  const pending = JSON.parse(ok('show', PROBLEM));
  assert.equal(pending.problem, PROBLEM);
  const [attempt] = pending.attempts;
  const { id, plannedAt, outcome, ...savedProposal } = attempt;
  assert.equal(id, 'first');
  assert.ok(Number.isFinite(Date.parse(plannedAt)));
  assert.equal(outcome, null);
  assert.deepEqual(savedProposal, PROPOSAL);

  ok('record', PROBLEM, 'first', input('outcome', OUTCOME));
  const [completed] = JSON.parse(ok('show', PROBLEM)).attempts;
  const { recordedAt, ...savedOutcome } = completed.outcome;
  assert.ok(Date.parse(recordedAt) >= Date.parse(plannedAt));
  assert.deepEqual(savedOutcome, OUTCOME);
  assert.deepEqual({ ...completed, outcome: null }, attempt);
});

test('retains rejected and accepted attempts under one problem across model changes', t => {
  const { ok, input } = fixture(t);
  const failed = { ...OUTCOME, observed: 'Neither fixture passed.', predictionStatus: 'missed', decision: 'rejected' };
  ok('plan', PROBLEM, 'z-first', input('plan-a', PROPOSAL));
  ok('record', PROBLEM, 'z-first', input('outcome-a', failed));

  const revised = { ...PROPOSAL, context: { ...PROPOSAL.context, model: 'policy-b', revision: 'candidate-b' } };
  ok('plan', PROBLEM, 'a-second', input('plan-b', revised));
  ok('record', PROBLEM, 'a-second', input('outcome-b', OUTCOME));
  ok('plan', 'tool-timeouts', 'z-first', input('another-problem', PROPOSAL));

  const history = JSON.parse(ok('show', PROBLEM));
  assert.deepEqual(history.attempts.map(attempt => [
    attempt.id, attempt.context.model, attempt.outcome.decision, attempt.outcome.predictionStatus,
  ]), [
    ['z-first', 'policy-a', 'rejected', 'missed'],
    ['a-second', 'policy-b', 'accepted', 'partially-met'],
  ]);
  assert.deepEqual(JSON.parse(ok('show')), [PROBLEM, 'tool-timeouts']);
});

test('refuses duplicate plans and results without overwriting history', t => {
  const { cli, ok, input } = fixture(t);
  ok('plan', PROBLEM, 'first', input('plan', PROPOSAL));
  ok('record', PROBLEM, 'first', input('outcome', OUTCOME));
  const original = ok('show', PROBLEM);

  const changed = { ...PROPOSAL, prediction: 'A different prediction.' };
  const plan = cli('plan', PROBLEM, 'first', input('changed-plan', changed));
  const record = cli('record', PROBLEM, 'first', input('changed-outcome', { ...OUTCOME, decision: 'rejected' }));
  for (const result of [plan, record]) {
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already exists/);
  }
  assert.equal(ok('show', PROBLEM), original);
});

test('accepts identical retries without updating the saved timestamps', t => {
  const { ok, input } = fixture(t);
  const plan = input('plan', PROPOSAL);
  const outcome = input('outcome', OUTCOME);
  ok('plan', PROBLEM, 'first', plan);
  ok('record', PROBLEM, 'first', outcome);
  const original = ok('show', PROBLEM);

  const reorderedPlan = { ...PROPOSAL, context: Object.fromEntries(Object.entries(PROPOSAL.context).reverse()) };
  ok('plan', PROBLEM, 'first', input('reordered-plan', reorderedPlan));
  ok('record', PROBLEM, 'first', outcome);
  assert.equal(ok('show', PROBLEM), original);
});

test('does not present an invalid saved outcome as pending', t => {
  const { cli, ok, input, stored } = fixture(t);
  ok('plan', PROBLEM, 'first', input('plan', PROPOSAL));
  writeFile(stored('first.outcome.json'), 'null');

  const result = cli('show', PROBLEM);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /first\.outcome\.json/);
  assert.equal(result.stdout, '');
});

test('refuses to record an outcome for a damaged plan', t => {
  const { cli, input, stored } = fixture(t);
  const invalid = { ...PROPOSAL, plannedAt: '2026-02-30T12:00:00.000Z' };
  writeFile(stored('first.plan.json'), JSON.stringify(invalid));

  const result = cli('record', PROBLEM, 'first', input('outcome', OUTCOME));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /first\.plan\.json.*plannedAt/);
  assert.equal(fs.existsSync(stored('first.outcome.json')), false);
});

test('an interrupted temporary write is invisible and leaves the attempt available', t => {
  const { ok, input, stored } = fixture(t);
  writeFile(stored('.interrupted.tmp'), '{ "prediction": ');
  assert.deepEqual(JSON.parse(ok('show')), []);
  ok('plan', PROBLEM, 'first', input('plan', PROPOSAL));

  const { attempts } = JSON.parse(ok('show', PROBLEM));
  assert.deepEqual(attempts.map(attempt => attempt.id), ['first']);
  assert.equal(attempts[0].outcome, null);
});

test('validates provenance, outcome fields and path identifiers before writing', t => {
  const { cli, ok, input } = fixture(t);
  const incomplete = input('incomplete', { ...PROPOSAL, context: { ...PROPOSAL.context, split: '' } });
  const noSplit = cli('plan', PROBLEM, 'first', incomplete);
  assert.equal(noSplit.code, 1);
  assert.match(noSplit.stderr, /context\.split/);

  const plan = input('plan', PROPOSAL);
  for (const [problem, attempt] of [['../escape', 'first'], [PROBLEM, '../../escape']]) {
    const rejected = cli('plan', problem, attempt, plan);
    assert.equal(rejected.code, 1);
    assert.match(rejected.stderr, /lowercase kebab-case/);
  }
  const noPlan = cli('record', PROBLEM, 'first', input('valid-outcome', OUTCOME));
  assert.equal(noPlan.code, 1);
  assert.match(noPlan.stderr, /no plan/);
  assert.deepEqual(JSON.parse(ok('show')), []);

  ok('plan', PROBLEM, 'first', plan);
  const invalid = input('invalid-outcome', { ...OUTCOME, predictionStatus: 'guess' });
  const rejected = cli('record', PROBLEM, 'first', invalid);
  assert.equal(rejected.code, 1);
  assert.match(rejected.stderr, /predictionStatus/);
  assert.equal(JSON.parse(ok('show', PROBLEM)).attempts[0].outcome, null);
});

test('rejects identifiers reserved on Windows before touching the store', t => {
  const { cli, ok, input } = fixture(t);
  const plan = input('plan', PROPOSAL);
  for (const [problem, attempt] of [['aux', 'first'], [PROBLEM, 'com1']]) {
    const result = cli('plan', problem, attempt, plan);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /reserved on Windows/);
  }
  assert.deepEqual(JSON.parse(ok('show')), []);
});

function race(env, command, files) {
  return Promise.all(files.map(file => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, command, PROBLEM, 'first', file], {
      env: { ...process.env, ...env }, stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('close', resolve);
  })));
}

test('allows only one concurrent writer for an attempt', async t => {
  const { ok, input, env } = fixture(t);
  const files = [PROPOSAL, { ...PROPOSAL, prediction: 'Neither fixture will pass.' }]
    .map((proposal, i) => input(`concurrent-${i}`, proposal));
  const statuses = await race(env, 'plan', files);

  assert.deepEqual([...statuses].sort(), [0, 1]);
  const { attempts } = JSON.parse(ok('show', PROBLEM));
  assert.equal(attempts.length, 1);
  const winner = statuses.indexOf(0);
  assert.equal(attempts[0].prediction, winner === 0 ? PROPOSAL.prediction : 'Neither fixture will pass.');
});

test('keeps one result when two evaluators record conflicting outcomes', async t => {
  const { ok, input, env } = fixture(t);
  ok('plan', PROBLEM, 'first', input('plan', PROPOSAL));
  const outcomes = [OUTCOME, { ...OUTCOME, decision: 'rejected' }];
  const statuses = await race(env, 'record', outcomes.map((outcome, i) => input(`outcome-${i}`, outcome)));

  assert.deepEqual([...statuses].sort(), [0, 1]);
  const [attempt] = JSON.parse(ok('show', PROBLEM)).attempts;
  const { recordedAt, ...saved } = attempt.outcome;
  assert.deepEqual(saved, outcomes[statuses.indexOf(0)]);
});
