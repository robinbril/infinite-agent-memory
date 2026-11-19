#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const POLICY_FILE = '.project-structure.json';
const ESSENTIAL_ROOT_FILES = new Set(['README.md', 'LICENSE', '.gitignore', '.gitattributes', '.editorconfig', POLICY_FILE]);
const HIDDEN_ROOT_DIRS = new Set(['.git', '.github', '.claude', '.codex', '.cursor', '.harness']);
const SOURCE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.ts', '.tsx', '.jsx', '.py']);
const RECOMMENDED_MAX_AREAS = 6;

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function normalize(rel) { return rel.split(path.sep).join('/'); }
function findProject(start) {
  let current = path.resolve(start);
  if (fs.existsSync(current) && !fs.statSync(current).isDirectory()) current = path.dirname(current);
  for (;;) {
    const file = path.join(current, POLICY_FILE);
    if (fs.existsSync(file)) return { root: current, policy: readJson(file) };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function areaNames(policy) { return Object.keys(policy.areas || {}); }
function validatePolicy(policy) {
  const errors = [];
  const names = areaNames(policy);
  if (!names.length) errors.push('policy needs at least one named area');
  for (const name of names) {
    const area = policy.areas[name];
    if (!/^[a-z][a-z0-9-]*$/.test(name)) errors.push(`area name ${name} must be lowercase kebab-case`);
    if (!area || typeof area.responsibility !== 'string' || !area.responsibility.trim()) errors.push(`area ${name} needs a responsibility`);
  }
  for (const name of policy.allowedRootFiles || []) if (typeof name !== 'string' || name.includes('/') || name.includes('\\')) errors.push(`invalid allowed root file ${name}`);
  return errors;
}
function policyAdvice(policy) {
  const count = areaNames(policy).length;
  return count > RECOMMENDED_MAX_AREAS ? [`policy has ${count} areas; review whether a junior can find each responsibility`] : [];
}
function allowedRootFile(name, policy) { return ESSENTIAL_ROOT_FILES.has(name) || (policy.allowedRootFiles || []).includes(name); }
function allowedRootDir(name, policy) { return HIDDEN_ROOT_DIRS.has(name) || areaNames(policy).includes(name); }
function validatePath(root, policy, target) {
  const rel = normalize(path.relative(root, path.resolve(target)));
  if (!rel || rel === '.') return [];
  if (rel.startsWith('../') || path.isAbsolute(rel)) return [`${target} is outside this project`];
  const parts = rel.split('/');
  const exists = fs.existsSync(target);
  const isDirectory = exists && fs.statSync(target).isDirectory();
  if (parts.length === 1 && isDirectory && !allowedRootDir(parts[0], policy)) return [`${parts[0]}/ is not a named project area`];
  if (parts.length === 1 && !isDirectory && !allowedRootFile(parts[0], policy)) return [`${parts[0]} is not an approved root file`];
  if (parts.length > 1 && !allowedRootDir(parts[0], policy)) return [`${parts[0]}/ is not a named project area`];
  return [];
}
function walk(root, visit, relative = '') {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const rel = path.join(relative, entry.name);
    if (entry.isDirectory()) walk(root, visit, rel); else visit(rel);
  }
}
function dependencyViolations(root, policy) {
  const errors = [];
  for (const rule of policy.forbiddenDependencies || []) {
    if (!areaNames(policy).includes(rule.from) || !areaNames(policy).includes(rule.to)) errors.push(`dependency rule ${rule.from} -> ${rule.to} names an unknown area`);
  }
  walk(root, rel => {
    if (!SOURCE_EXTENSIONS.has(path.extname(rel)) || path.extname(rel) === '.py') return;
    const from = normalize(rel).split('/')[0];
    const source = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const rule of policy.forbiddenDependencies || []) {
      if (from !== rule.from) continue;
      const specifiers = [...source.matchAll(/(?:from\s*|import\s*|require\s*\()(['\"])([^'\"]+)\1/g)].map(match => match[2]);
      const violates = specifiers.some(specifier => {
        if (!specifier.startsWith('.')) return specifier === rule.to || specifier.startsWith(`${rule.to}/`);
        const destination = normalize(path.relative(root, path.resolve(path.dirname(path.join(root, rel)), specifier)));
        return destination === rule.to || destination.startsWith(`${rule.to}/`);
      });
      if (violates) errors.push(`${normalize(rel)} depends on forbidden ${rule.to}/ area`);
    }
  });
  return errors;
}
function validateProject(root) {
  const found = findProject(root);
  if (!found) return { errors: [], advice: [] };
  const errors = validatePolicy(found.policy);
  for (const entry of fs.readdirSync(found.root, { withFileTypes: true })) if (entry.name !== '.git') errors.push(...validatePath(found.root, found.policy, path.join(found.root, entry.name)));
  if (found.policy.boundariesDocument && !fs.existsSync(path.join(found.root, found.policy.boundariesDocument))) errors.push(`missing required boundaries document: ${found.policy.boundariesDocument}`);
  errors.push(...dependencyViolations(found.root, found.policy));
  return { errors, advice: policyAdvice(found.policy), root: found.root, policy: found.policy };
}
function validateWrite(target, cwd) {
  const found = findProject(cwd);
  if (!found) return { errors: [], advice: [] };
  return { errors: [...validatePolicy(found.policy), ...validatePath(found.root, found.policy, target)], root: found.root, policy: found.policy };
}
function main(argv) {
  const index = argv.indexOf('--repo');
  if (index >= 0) return validateProject(argv[index + 1] || process.cwd());
  const pathIndex = argv.indexOf('--path');
  if (pathIndex >= 0) return validateWrite(argv[pathIndex + 1], argv[argv.indexOf('--cwd') + 1] || process.cwd());
  throw Error('Use --repo <directory> or --path <file> --cwd <directory>.');
}
if (require.main === module) {
  try { const result = main(process.argv.slice(2)); if (result.advice && result.advice.length) process.stderr.write(result.advice.map(item => `[project-structure] advice: ${item}`).join('\n') + '\n'); if (result.errors.length) { process.stderr.write(result.errors.map(error => `[project-structure] ${error}`).join('\n') + '\n'); process.exitCode = 2; } }
  catch (error) { process.stderr.write(`[project-structure] ${error.message}\n`); process.exitCode = 2; }
}
module.exports = { findProject, policyAdvice, validatePolicy, validatePath, validateProject, validateWrite, RECOMMENDED_MAX_AREAS };
