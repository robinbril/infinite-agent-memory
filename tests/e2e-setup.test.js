'use strict';
/**
 * tests/e2e-setup.test.js
 * Tests for scripts/e2e-setup.js against a throwaway HOME.
 * Uses Node's built-in test runner (node --test). Zero external deps.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('path');
const fs     = require('fs');

const { makeTmpDir, rmDir, writeFile, run } = require('./helpers.js');
const { upsertBlock, removeBlock, upsertToml, removeTomlTable } = require('../scripts/e2e-setup.js');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'e2e-setup.js');
const NPX    = '/opt/node/bin/npx';

let roots = [];
after(() => { for (const r of roots) rmDir(r); });

// A HOME with Claude, Codex and Cursor present, plus a fake upstream skill.
function freshHome() {
  const home = makeTmpDir('e2e-home');
  roots.push(home);
  writeFile(path.join(home, '.codex', 'config.toml'),
    'notify = ["x"]\n\n[mcp_servers.node_repl]\ncommand = "node_repl"\nargs = []\n');
  writeFile(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { figma: { command: 'figma-mcp' } } }));
  writeFile(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 3 }));
  writeFile(path.join(home, '.claude', 'CLAUDE.md'), '# My rules\n\n- be brief\n');
  const upstream = path.join(home, 'upstream-skill');
  writeFile(path.join(upstream, 'SKILL.md'), '---\nname: e2e\n---\n# e2e\n');
  return { home, upstream };
}

function setup(cmd, home, extra) {
  return run('node', [SCRIPT, cmd, '--home', home, '--npx', NPX, ...(extra || [])]);
}

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

// ---------------------------------------------------------------------------

describe('e2e-setup install', () => {

  it('wires skills, template, MCP and rules for all three agents', () => {
    const { home, upstream } = freshHome();
    const { code, stdout } = setup('install', home, ['--skill-src', upstream]);
    assert.equal(code, 0, stdout);

    assert.match(read(home, '.agents', 'skills', 'e2e', 'SKILL.md'), /name: e2e/);
    assert.match(read(home, '.agents', 'skills', 'e2e-rules', 'SKILL.md'), /name: e2e-rules/);
    assert.match(read(home, '.agents', 'e2e', 'e2e.config.template.ts'), /e2e\/oauth\/chatgpt/);
    for (const agent of ['.claude', '.codex', '.cursor']) {
      for (const name of ['e2e', 'e2e-rules']) {
        const link = path.join(home, agent, 'skills', name);
        assert.ok(fs.lstatSync(link).isSymbolicLink(), link);
        assert.ok(fs.existsSync(path.join(link, 'SKILL.md')), link);
      }
    }

    const entry = { command: NPX, args: ['-y', 'e2e', 'mcp'] };
    const claude = JSON.parse(read(home, '.claude.json'));
    assert.deepEqual(claude.mcpServers.e2e, entry);
    assert.equal(claude.numStartups, 3);
    const cursor = JSON.parse(read(home, '.cursor', 'mcp.json'));
    assert.deepEqual(cursor.mcpServers, { figma: { command: 'figma-mcp' }, e2e: entry });

    const toml = read(home, '.codex', 'config.toml');
    assert.match(toml, /\[mcp_servers\.node_repl\]/);
    assert.match(toml, /\[mcp_servers\.e2e\]\ncommand = "\/opt\/node\/bin\/npx"\nargs = \["-y", "e2e", "mcp"\]/);

    const claudeMd = read(home, '.claude', 'CLAUDE.md');
    assert.match(claudeMd, /^# My rules\n\n- be brief\n/);
    assert.match(claudeMd, /ChatGPT subscription only/);
    assert.match(read(home, '.codex', 'AGENTS.md'), /\*\.e2e\.ts/);
  });

  it('is idempotent: a second run changes nothing', () => {
    const { home, upstream } = freshHome();
    setup('install', home, ['--skill-src', upstream]);
    const files = ['.claude.json', '.codex/config.toml', '.cursor/mcp.json', '.claude/CLAUDE.md', '.codex/AGENTS.md'];
    const before = files.map((f) => read(home, f));
    const { code } = setup('install', home, ['--skill-src', upstream]);
    assert.equal(code, 0);
    assert.deepEqual(files.map((f) => read(home, f)), before);
    assert.equal((read(home, '.codex', 'config.toml').match(/\[mcp_servers\.e2e\]/g) || []).length, 1);
  });

  it('skips Codex and Cursor when they are not installed', () => {
    const home = makeTmpDir('e2e-home');
    roots.push(home);
    const upstream = path.join(home, 'up');
    writeFile(path.join(upstream, 'SKILL.md'), '---\nname: e2e\n---\n');
    const { code } = setup('install', home, ['--skill-src', upstream]);
    assert.equal(code, 0);
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'e2e')));
    assert.ok(!fs.existsSync(path.join(home, '.codex')));
    assert.ok(!fs.existsSync(path.join(home, '.cursor')));
  });

  it('--dry-run writes nothing', () => {
    const { home, upstream } = freshHome();
    const before = read(home, '.codex', 'config.toml');
    const { code, stdout } = setup('install', home, ['--skill-src', upstream, '--dry-run']);
    assert.equal(code, 0);
    assert.match(stdout, /\[dry-run\] would:/);
    assert.equal(read(home, '.codex', 'config.toml'), before);
    assert.ok(!fs.existsSync(path.join(home, '.agents')));
  });
});

describe('e2e-setup uninstall', () => {

  it('removes everything it added and keeps the rest', () => {
    const { home, upstream } = freshHome();
    const tomlBefore = read(home, '.codex', 'config.toml');
    setup('install', home, ['--skill-src', upstream]);
    const { code, stdout } = setup('uninstall', home);
    assert.equal(code, 0, stdout);

    assert.ok(!fs.existsSync(path.join(home, '.agents', 'skills', 'e2e')));
    assert.ok(!fs.existsSync(path.join(home, '.agents', 'e2e')));
    for (const agent of ['.claude', '.codex', '.cursor']) {
      assert.ok(!fs.existsSync(path.join(home, agent, 'skills', 'e2e')));
    }
    assert.equal(JSON.parse(read(home, '.claude.json')).mcpServers.e2e, undefined);
    assert.deepEqual(JSON.parse(read(home, '.cursor', 'mcp.json')).mcpServers, { figma: { command: 'figma-mcp' } });
    assert.equal(read(home, '.codex', 'config.toml'), tomlBefore);
    assert.equal(read(home, '.claude', 'CLAUDE.md'), '# My rules\n\n- be brief\n');
    assert.ok(!fs.existsSync(path.join(home, '.codex', 'AGENTS.md')));
  });
});

describe('e2e-setup helpers', () => {

  it('upsertBlock replaces an existing block in place', () => {
    const once = upsertBlock('intro\n', 'v1');
    const twice = upsertBlock(once + '\noutro\n', 'v2');
    assert.match(twice, /v2/);
    assert.doesNotMatch(twice, /v1/);
    assert.match(twice, /outro/);
    assert.equal(removeBlock(upsertBlock('intro\n', 'v1')).trim(), 'intro');
  });

  it('removeTomlTable keeps brackets in values and drops sub-tables', () => {
    const toml = '[a]\nx = ["1"]\n\n[mcp_servers.e2e]\nargs = ["-y", "e2e"]\n\n[mcp_servers.e2e.env]\nK = "v"\n\n[b]\ny = 2\n';
    assert.equal(removeTomlTable(toml), '[a]\nx = ["1"]\n\n[b]\ny = 2\n');
    assert.equal(upsertToml(upsertToml(toml, 'npx'), 'npx'), upsertToml(toml, 'npx'));
  });
});
