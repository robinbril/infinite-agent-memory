#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const root = path.resolve(args.includes('--repo') ? args[args.indexOf('--repo') + 1] : process.cwd());
const entries = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.name !== '.git');
const rootFiles = entries.filter(entry => !entry.isDirectory()).map(entry => entry.name).sort();
const areas = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => entry.name).sort();
const references = [];
function walk(relative = '') {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) walk(next);
    else if (/\.(yml|yaml|json|js|cjs|mjs|ts|py|sh|ps1)$/i.test(entry.name)) {
      const source = fs.readFileSync(path.join(root, next), 'utf8');
      for (const area of areas) if (source.includes(`${area}/`) || source.includes(`./${area}`)) references.push({ file: next.split(path.sep).join('/'), area });
    }
  }
}
walk();
console.log(JSON.stringify({ root, areas, rootFiles, references }, null, 2));
