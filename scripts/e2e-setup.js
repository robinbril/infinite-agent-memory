#!/usr/bin/env node
'use strict';
/**
 * scripts/e2e-setup.js
 * Wires e2e (TesterArmy agentic UI tests, https://github.com/tester-army/e2e)
 * into Claude Code, Codex and Cursor, globally:
 *
 *   ~/.agents/skills/e2e        upstream e2e skill (fetched from GitHub)
 *   ~/.agents/skills/e2e-rules  house rules (skills/e2e-rules in this repo)
 *   ~/.agents/e2e/              config template (Claude seat via poort, no API keys)
 *   <agent>/skills/{e2e,e2e-rules} -> links into ~/.agents/skills
 *   MCP server `e2e` (npx -y e2e@<E2E_VERSION> mcp) in ~/.claude.json, ~/.codex/config.toml,
 *   ~/.cursor/mcp.json
 *   rules block in ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md
 *
 * Codex and Cursor are only wired when ~/.codex or ~/.cursor exists.
 * Idempotent: re-running install refreshes the upstream skill and rules.
 *
 * Usage:
 *   node scripts/e2e-setup.js install   [--dry-run] [--home DIR] [--skill-src DIR] [--npx PATH]
 *   node scripts/e2e-setup.js uninstall [--dry-run] [--home DIR]
 *
 * --skill-src copies the upstream skill from a local checkout instead of
 * cloning https://github.com/tester-army/e2e (used by tests and offline).
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawnSync } = require('child_process');

const REPO_DIR     = path.join(__dirname, '..');
const UPSTREAM_GIT = 'https://github.com/tester-army/e2e';
const MCP_NAME     = 'e2e';
// Pinned, like the projects pin `e2e`: an unpinned `npx -y e2e` pulls whatever
// npm serves at launch, so the MCP server and the project's runner can drift.
const E2E_VERSION  = '0.18.0';
const E2E_SPEC     = 'e2e@' + E2E_VERSION;
const MARK_START   = '<!-- infinite-agent-memory:e2e:start -->';
const MARK_END     = '<!-- infinite-agent-memory:e2e:end -->';

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { cmd: argv[0], dryRun: false, home: os.homedir(), skillSrc: '', npx: '' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--home') opts.home = argv[++i];
    else if (a === '--skill-src') opts.skillSrc = argv[++i];
    else if (a === '--npx') opts.npx = argv[++i];
    else throw new Error('Unknown argument: ' + a);
  }
  if (opts.cmd !== 'install' && opts.cmd !== 'uninstall') {
    throw new Error('Usage: e2e-setup.js install|uninstall [--dry-run] [--home DIR] [--skill-src DIR] [--npx PATH]');
  }
  return opts;
}

function paths(home) {
  const agents = path.join(home, '.agents');
  return {
    agentsSkills: path.join(agents, 'skills'),
    agentsE2e:    path.join(agents, 'e2e'),
    claudeDir:    path.join(home, '.claude'),
    claudeJson:   path.join(home, '.claude.json'),
    claudeMd:     path.join(home, '.claude', 'CLAUDE.md'),
    codexDir:     path.join(home, '.codex'),
    codexToml:    path.join(home, '.codex', 'config.toml'),
    codexAgents:  path.join(home, '.codex', 'AGENTS.md'),
    cursorDir:    path.join(home, '.cursor'),
    cursorMcp:    path.join(home, '.cursor', 'mcp.json'),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function makeIo(dryRun) {
  return {
    ok:   (msg) => console.log('[ok] ' + msg),
    warn: (msg) => console.log('[warn] ' + msg),
    // do(desc, fn): run fn, or only describe it in dry-run mode
    do: (desc, fn) => {
      if (dryRun) { console.log('[dry-run] would: ' + desc); return; }
      fn();
      console.log('[ok] ' + desc);
    },
  };
}

function readJson(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').replace(/^/, '');
  if (raw.trim() === '') return {};
  try { return JSON.parse(raw); }
  catch (e) { throw new Error('Could not parse ' + file + ': ' + e.message); }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function findNpx() {
  const names = process.platform === 'win32' ? ['npx.cmd', 'npx'] : ['npx'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (dir && fs.existsSync(p)) return p;
    }
  }
  return 'npx';
}

function rulesBody() {
  const skill = fs.readFileSync(path.join(REPO_DIR, 'skills', 'e2e-rules', 'SKILL.md'), 'utf8');
  return skill.replace(/^---[\s\S]*?---\s*/, '').replace(/^# .*\n+/, '').trim();
}

// Replace (or append) the marked block in a markdown file.
function upsertBlock(text, block) {
  const wrapped = MARK_START + '\n## e2e tests\n\n' + block + '\n' + MARK_END;
  const re = new RegExp(MARK_START + '[\\s\\S]*?' + MARK_END);
  if (re.test(text)) return text.replace(re, wrapped);
  return (text.trim() === '' ? '' : text.replace(/\s*$/, '\n\n')) + wrapped + '\n';
}

function removeBlock(text) {
  const re = new RegExp('\\n*' + MARK_START + '[\\s\\S]*?' + MARK_END + '\\n?');
  return text.replace(re, '\n').replace(/^\n+/, '');
}

function tomlBlock(npx) {
  return '[mcp_servers.e2e]\ncommand = ' + JSON.stringify(npx) +
    '\nargs = ["-y", "' + E2E_SPEC + '", "mcp"]\nstartup_timeout_sec = 60\n';
}

// TOML: drop the [mcp_servers.e2e] table (and its sub-tables) up to the next
// unrelated table header. Line-based, since values may contain brackets.
function removeTomlTable(toml) {
  const out = [];
  let skipping = false;
  for (const line of toml.split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) skipping = header[1] === 'mcp_servers.e2e' || header[1].startsWith('mcp_servers.e2e.');
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n');
}

function upsertToml(toml, npx) {
  const rest = removeTomlTable(toml);
  return (rest.trim() === '' ? '' : rest + '\n') + tomlBlock(npx);
}

function linkDir(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try { fs.rmSync(link, { recursive: true, force: true }); } catch (_) {}
  // junctions need no admin rights on Windows; ignored elsewhere
  fs.symlinkSync(target, link, 'junction');
}

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

function fetchUpstreamSkill(skillSrc) {
  if (skillSrc) return { dir: skillSrc, cleanup: () => {} };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-upstream-'));
  const r = spawnSync('git', ['clone', '--depth', '1', '-q', UPSTREAM_GIT, tmp], { encoding: 'utf8' });
  if (r.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error('git clone ' + UPSTREAM_GIT + ' failed: ' + (r.stderr || r.error || '').toString().trim());
  }
  return { dir: path.join(tmp, 'skills', 'e2e'), cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

// Which agent homes to wire: Claude always, Codex/Cursor when installed.
function agentSkillDirs(p) {
  const dirs = [path.join(p.claudeDir, 'skills')];
  if (fs.existsSync(p.codexDir)) dirs.push(path.join(p.codexDir, 'skills'));
  if (fs.existsSync(p.cursorDir)) dirs.push(path.join(p.cursorDir, 'skills'));
  return dirs;
}

// ── install ──────────────────────────────────────────────────────────────────
function install(opts) {
  const io  = makeIo(opts.dryRun);
  const p   = paths(opts.home);
  const npx = opts.npx || findNpx();
  const mcpEntry = { command: npx, args: ['-y', E2E_SPEC, 'mcp'] };

  console.log('\n==> e2e skills');
  const upstreamDest = path.join(p.agentsSkills, 'e2e');
  const rulesDest    = path.join(p.agentsSkills, 'e2e-rules');
  if (opts.dryRun) {
    io.do('fetch upstream e2e skill into ' + upstreamDest, () => {});
  } else {
    let upstream;
    try {
      upstream = fetchUpstreamSkill(opts.skillSrc);
      copyDir(upstream.dir, upstreamDest);
      io.ok('upstream e2e skill -> ' + upstreamDest);
    } catch (e) {
      io.warn(e.message + ' (skipping upstream skill; re-run to retry)');
    } finally {
      if (upstream) upstream.cleanup();
    }
  }
  io.do('copy skills/e2e-rules -> ' + rulesDest,
    () => copyDir(path.join(REPO_DIR, 'skills', 'e2e-rules'), rulesDest));
  for (const skillsDir of agentSkillDirs(p)) {
    for (const name of ['e2e', 'e2e-rules']) {
      const link = path.join(skillsDir, name);
      io.do('link ' + link, () => linkDir(path.join(p.agentsSkills, name), link));
    }
  }

  console.log('\n==> e2e config template');
  const tpl = path.join(p.agentsE2e, 'e2e.config.template.ts');
  io.do('copy e2e/e2e.config.template.ts -> ' + tpl, () => {
    fs.mkdirSync(p.agentsE2e, { recursive: true });
    fs.copyFileSync(path.join(REPO_DIR, 'e2e', 'e2e.config.template.ts'), tpl);
  });

  console.log('\n==> e2e MCP server (' + npx + ' -y ' + E2E_SPEC + ' mcp)');
  const jsonTargets = [['Claude Code', p.claudeJson]];
  if (fs.existsSync(p.cursorDir)) jsonTargets.push(['Cursor', p.cursorMcp]);
  for (const [label, file] of jsonTargets) {
    const data = readJson(file);
    const current = data.mcpServers && data.mcpServers[MCP_NAME];
    if (current && current.command === mcpEntry.command &&
        JSON.stringify(current.args) === JSON.stringify(mcpEntry.args)) {
      io.ok(label + ': already registered in ' + file);
      continue;
    }
    io.do(label + ': register in ' + file, () => {
      data.mcpServers = Object.assign({}, data.mcpServers, { [MCP_NAME]: mcpEntry });
      writeJson(file, data);
    });
  }
  if (fs.existsSync(p.codexDir)) {
    const toml = fs.existsSync(p.codexToml) ? fs.readFileSync(p.codexToml, 'utf8') : '';
    const next = upsertToml(toml, npx);
    if (next === toml) io.ok('Codex: already registered in ' + p.codexToml);
    else io.do('Codex: register in ' + p.codexToml, () => fs.writeFileSync(p.codexToml, next, 'utf8'));
  }

  console.log('\n==> e2e rules');
  const block = rulesBody();
  const mdTargets = [p.claudeMd];
  if (fs.existsSync(p.codexDir)) mdTargets.push(p.codexAgents);
  for (const file of mdTargets) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const next = upsertBlock(text, block);
    if (next === text) io.ok('rules up to date in ' + file);
    else io.do('write rules block in ' + file, () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, next, 'utf8');
    });
  }

  console.log('\nNext: make sure `claude` is signed in (run `claude` once, or set CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`), then restart Codex/Cursor.');
}

// ── uninstall ────────────────────────────────────────────────────────────────
function uninstall(opts) {
  const io = makeIo(opts.dryRun);
  const p  = paths(opts.home);

  console.log('\n==> e2e skills');
  for (const skillsDir of [p.claudeDir, p.codexDir, p.cursorDir].map((d) => path.join(d, 'skills'))) {
    for (const name of ['e2e', 'e2e-rules']) {
      const link = path.join(skillsDir, name);
      let isLink = false;
      try { isLink = fs.lstatSync(link).isSymbolicLink(); } catch (_) {}
      if (isLink) io.do('remove link ' + link, () => fs.rmSync(link, { force: true }));
    }
  }
  for (const dir of [path.join(p.agentsSkills, 'e2e'), path.join(p.agentsSkills, 'e2e-rules'), p.agentsE2e]) {
    if (fs.existsSync(dir)) io.do('remove ' + dir, () => fs.rmSync(dir, { recursive: true, force: true }));
  }

  console.log('\n==> e2e MCP server');
  for (const file of [p.claudeJson, p.cursorMcp]) {
    if (!fs.existsSync(file)) continue;
    const data = readJson(file);
    if (!data.mcpServers || !data.mcpServers[MCP_NAME]) continue;
    io.do('unregister from ' + file, () => { delete data.mcpServers[MCP_NAME]; writeJson(file, data); });
  }
  if (fs.existsSync(p.codexToml)) {
    const toml = fs.readFileSync(p.codexToml, 'utf8');
    const next = removeTomlTable(toml);
    if (next.trim() !== toml.trim()) {
      io.do('unregister from ' + p.codexToml, () => fs.writeFileSync(p.codexToml, next, 'utf8'));
    }
  }

  console.log('\n==> e2e rules');
  for (const file of [p.claudeMd, p.codexAgents]) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(MARK_START)) continue;
    io.do('remove rules block from ' + file, () => {
      const next = removeBlock(text);
      if (next.trim() === '') fs.rmSync(file);
      else fs.writeFileSync(file, next, 'utf8');
    });
  }
  console.log('\nKept: your Claude sign-in, and ~/.config/e2e/oauth.json if an older setup signed in to ChatGPT (remove it with `npx e2e logout openai`).');
}

// ── main ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.cmd === 'install') install(opts); else uninstall(opts);
  } catch (e) {
    console.error('[e2e-setup] ' + e.message);
    process.exit(1);
  }
}

module.exports = { upsertBlock, removeBlock, upsertToml, removeTomlTable };
