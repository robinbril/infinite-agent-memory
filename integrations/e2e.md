# e2e integration (agentic UI tests)

[e2e](https://github.com/tester-army/e2e) by TesterArmy is an open-source TypeScript framework for end-to-end UI tests. `agent.act` drives a goal in a real browser, iOS simulator or Android emulator; `agent.assert` and an exact `expect` check the result. Passing agent steps are cached in `.e2e/cache/` and replayed without a model call.

`--with-e2e` makes it available to Claude Code, Codex and Cursor in every project, with the model coming from a ChatGPT subscription (no API keys).

## Install

```bash
bash install.sh --with-e2e            # macOS / Linux
powershell -File install.ps1 -WithE2E # Windows
npx e2e login openai                  # once: sign in with ChatGPT Plus/Pro
```

Or on its own: `node scripts/e2e-setup.js install [--dry-run]`. Re-running it pulls the latest upstream skill. Restart Codex and Cursor afterwards so they load the MCP server.

## What it wires

| Piece | Location | Agents |
|---|---|---|
| Upstream `e2e` skill | `~/.agents/skills/e2e` | linked from `~/.claude/skills`, `~/.codex/skills`, `~/.cursor/skills` |
| House rules skill [`e2e-rules`](../skills/e2e-rules/SKILL.md) | `~/.agents/skills/e2e-rules` | same links |
| Rules block (always loaded) | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` | Claude Code, Codex |
| MCP server `e2e` (`npx -y e2e mcp`) | `~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json` | all three |
| Config template | `~/.agents/e2e/e2e.config.template.ts` | copied into a project by the agent |

Codex and Cursor are skipped when `~/.codex` or `~/.cursor` does not exist. Existing content in those files is kept; the rules block sits between `infinite-agent-memory:e2e` markers. `npx` is written as an absolute path so GUI apps that do not load your shell PATH still find it.

## Models

The [template](../e2e/e2e.config.template.ts) uses `e2e/oauth/chatgpt`: `gpt-6-luna` acts, `gpt-6-sol` judges as a second opinion. Override per run with `E2E_MODEL` / `E2E_JUDGE`; `npx e2e models` lists what your subscription serves. The sign-in lives in `~/.config/e2e/oauth.json`; for CI, put that JSON in the `E2E_OAUTH_CREDENTIALS` secret (read-only there, so re-fill it when the session expires).

## In a project

The agent copies the template to `e2e.config.ts`, sets the app start command and URL in `targets`, installs `e2e @e2e-dev/web ai @ai-sdk/openai`, and writes tests as `tests/*.e2e.ts`. A task counts as done when `npx e2e run --reporter list,markdown` passes; failures are read from `.e2e/summary.md`.

## Uninstall

```bash
bash uninstall.sh --with-e2e
```

Removes the skills, links, template, MCP entries and rules block. The ChatGPT sign-in stays; remove it with `npx e2e logout openai`.
