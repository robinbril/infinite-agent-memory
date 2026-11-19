#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const root = path.resolve(value('--repo') || process.cwd());
const names = String(value('--areas') || '').split(',').map(name => name.trim()).filter(Boolean);
if (!names.length) throw Error('Use --areas with one or more comma-separated areas.');
const policyFile = path.join(root, '.project-structure.json');
if (fs.existsSync(policyFile)) throw Error('.project-structure.json already exists; edit it deliberately instead.');
const areas = Object.fromEntries(names.map(name => [name, { responsibility: 'Describe this area before relying on the contract.' }]));
fs.writeFileSync(policyFile, `${JSON.stringify({ areas, allowedRootFiles: [], boundariesDocument: 'docs/architecture.md', forbiddenDependencies: [] }, null, 2)}\n`);
console.log(policyFile);
