#!/usr/bin/env node
/**
 * transcript-digest.js  <transcript.jsonl>
 *
 * Collapses a Claude Code session transcript (often tens of MB, mostly tool
 * output) into a compact markdown digest that fits a model context: user turns
 * and assistant prose verbatim, tool calls as one-line markers, tool OUTPUT
 * dropped entirely. Emits the digest to stdout.
 *
 * Used by the distill runner to prepare transcripts for distillation into memory.
 */
'use strict';

const fs = require('fs');

const MAX_TURN_CHARS = 4000;     // cap a single user/assistant block
const MAX_DIGEST_CHARS = 90000;  // hard cap per session digest (~22k tokens)

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const p of content) {
    if (typeof p === 'string') { parts.push(p); continue; }
    if (p.type === 'text' && p.text) parts.push(p.text);
    else if (p.type === 'tool_use') {
      const fp = p.input && (p.input.file_path || p.input.path || p.input.command);
      parts.push(`[tool: ${p.name}${fp ? ' ' + String(fp).slice(0, 120) : ''}]`);
    }
    // tool_result / images / thinking are dropped on purpose
  }
  return parts.join('\n');
}

function isNoise(txt) {
  if (!txt) return true;
  const t = txt.trim();
  if (!t) return true;
  if (t.startsWith('<')) return true;                 // system reminders, tool-result envelopes
  if (t.startsWith('Caveat:')) return true;
  if (/^\[Request interrupted/.test(t)) return true;
  return false;
}

function main() {
  const file = process.argv[2];
  if (!file) { process.exit(0); }
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch (_) { process.exit(0); }

  const out = [];
  let total = 0;
  for (const ln of lines) {
    if (!ln) continue;
    let o;
    try { o = JSON.parse(ln); } catch (_) { continue; }
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    if (!o.message) continue;

    let txt = textOf(o.message.content);
    if (o.type === 'user' && isNoise(txt)) continue;
    txt = txt.trim();
    if (!txt) continue;
    if (txt.length > MAX_TURN_CHARS) txt = txt.slice(0, MAX_TURN_CHARS) + ' ...[truncated]';

    const block = `## ${o.type === 'user' ? 'User' : 'Assistant'}\n${txt}\n`;
    out.push(block);
    total += block.length;
    if (total > MAX_DIGEST_CHARS) { out.push('\n...[digest truncated: session exceeds limit]'); break; }
  }

  process.stdout.write(out.join('\n'));
}

main();
