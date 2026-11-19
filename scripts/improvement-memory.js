#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const memoryDir = process.env.AGENT_MEMORY_DIR || path.join(os.homedir(), 'agent-memory');
const store = path.join(memoryDir, '_improvements');
const PLAN = { suffix: '.plan.json', timestamp: 'plannedAt', validate: validatePlan };
const OUTCOME = { suffix: '.outcome.json', timestamp: 'recordedAt', validate: validateOutcome };
const usage = [
  'Usage: node scripts/improvement-memory.js plan <problem> <attempt> <plan.json>',
  '       node scripts/improvement-memory.js record <problem> <attempt> <outcome.json>',
  '       node scripts/improvement-memory.js show [problem]',
].join('\n');

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON in ${file}`);
  }
}

function inputFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  for (const key of Object.keys(value)) {
    if (!fields.includes(key)) throw new Error(`unknown field ${label}.${key}`);
  }
}

function requireTextFields(value, fields, label) {
  for (const field of fields) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new Error(`${label}.${field} must be a non-empty string`);
    }
  }
}

function validatePlan(plan) {
  const fields = ['diagnosis', 'change', 'rationale', 'prediction'];
  const contextFields = ['model', 'benchmark', 'split', 'revision'];
  inputFields(plan, [...fields, 'context'], 'plan');
  requireTextFields(plan, fields, 'plan');
  inputFields(plan.context, contextFields, 'context');
  requireTextFields(plan.context, contextFields, 'context');
}

function validateOutcome(outcome) {
  const fields = ['observed', 'evidence', 'predictionStatus', 'decision'];
  inputFields(outcome, fields, 'outcome');
  requireTextFields(outcome, fields, 'outcome');
  if (!['met', 'partially-met', 'missed', 'inconclusive'].includes(outcome.predictionStatus)) {
    throw new Error('outcome.predictionStatus must be met, partially-met, missed or inconclusive');
  }
  if (!['accepted', 'rejected'].includes(outcome.decision)) {
    throw new Error('outcome.decision must be accepted or rejected');
  }
}

function requireSlug(value, label) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`${label} must be lowercase kebab-case`);
  }
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value)) {
    throw new Error(`${label} is reserved on Windows`);
  }
}

function readRecord(file, kind) {
  const record = readJson(file);
  const { [kind.timestamp]: timestamp, ...data } = record ?? {};
  try {
    const date = new Date(typeof timestamp === 'string' ? timestamp : NaN);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== timestamp) {
      throw new Error(`${kind.timestamp} must be a UTC timestamp in ISO format`);
    }
    kind.validate(data);
  } catch (error) {
    throw new Error(`invalid record in ${file}: ${error.message}`);
  }
  return record;
}

function writeOnce(file, kind, data) {
  const temp = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try {
      const record = { ...data, [kind.timestamp]: new Date().toISOString() };
      fs.writeFileSync(fd, JSON.stringify(record, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Publish a complete file atomically without replacing an existing record.
    fs.linkSync(temp, file);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const { [kind.timestamp]: savedAt, ...saved } = readRecord(file, kind);
    if (!isDeepStrictEqual(saved, data)) throw new Error(`${path.basename(file)} already exists with different data`);
  } finally {
    fs.unlinkSync(temp);
  }
}

function missingAs(read, fallback) {
  try {
    return read();
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function plansIn(dir) {
  return missingAs(() => fs.readdirSync(dir, { withFileTypes: true }), [])
    .filter(entry => entry.isFile() && entry.name.endsWith(PLAN.suffix))
    .map(entry => entry.name.slice(0, -PLAN.suffix.length));
}

function show(problem) {
  if (problem === undefined) {
    const entries = missingAs(() => fs.readdirSync(store, { withFileTypes: true }), []);
    return entries.filter(entry => entry.isDirectory() && plansIn(path.join(store, entry.name)).length)
      .map(entry => entry.name).sort();
  }

  requireSlug(problem, 'problem');
  const dir = path.join(store, problem);
  const attempts = plansIn(dir).sort().map(id => ({
    id,
    ...readRecord(path.join(dir, id + PLAN.suffix), PLAN),
    outcome: missingAs(() => readRecord(path.join(dir, id + OUTCOME.suffix), OUTCOME), null),
  }));
  if (!attempts.length) throw new Error(`unknown problem: ${problem}`);
  attempts.sort((a, b) => a.plannedAt.localeCompare(b.plannedAt));
  return { problem, attempts };
}

function planAttempt(dir, id, plan) {
  validatePlan(plan);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeOnce(path.join(dir, id + PLAN.suffix), PLAN, plan);
}

function recordOutcome(dir, id, outcome) {
  validateOutcome(outcome);
  const plan = missingAs(() => readRecord(path.join(dir, id + PLAN.suffix), PLAN), null);
  if (plan === null) throw new Error(`no plan for attempt ${id}`);
  writeOnce(path.join(dir, id + OUTCOME.suffix), OUTCOME, outcome);
}

function main(args) {
  const [command, problem, id, file] = args;
  if (command === '--help' && args.length === 1) {
    console.log(usage);
    return;
  }
  if (command === 'show' && args.length <= 2) {
    console.log(JSON.stringify(show(problem), null, 2));
    return;
  }
  if (!['plan', 'record'].includes(command) || args.length !== 4) throw new Error(usage);

  requireSlug(problem, 'problem');
  requireSlug(id, 'attempt');
  const dir = path.join(store, problem);
  const input = readJson(file);
  if (command === 'plan') planAttempt(dir, id, input);
  else recordOutcome(dir, id, input);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(`improvement-memory: ${error.message}`);
  process.exitCode = 1;
}
