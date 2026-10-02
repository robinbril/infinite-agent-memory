---
name: e2e-rules
description: House rules for end-to-end UI tests with e2e (TesterArmy). Use alongside the e2e skill on any UI change in a web or mobile app, when setting up e2e in a project, and when an e2e run fails. Covers the subscription-only model setup, the config template, file naming, and when a task counts as done.
---

# e2e house rules

- On a UI change in a web or mobile app: add or update an e2e test. Use the `e2e` skill and the `e2e` MCP server.
- Project without e2e: copy `~/.agents/e2e/e2e.config.template.ts` to `e2e.config.ts`, adjust `targets` (start command, URL), then `npm i -D e2e @e2e-dev/web ai @ai-sdk/openai`. Do not run `npx e2e init` over an existing config.
- Test files are named `*.e2e.ts` and live in `tests/`.
- Models come from the ChatGPT subscription only (`e2e/oauth/chatgpt`): no API keys, no other providers. Switch models with `E2E_MODEL` / `E2E_JUDGE` (ids from `npx e2e models`). Not signed in: ask the user to run `npx e2e login openai`.
- One `agent.act` per goal, followed by an exact `expect`.
- Done = `npx e2e run --reporter list,markdown` passes. On failure, read `.e2e/summary.md` and the failure page before changing code.
- After changing a test, run it once with `--no-cache`. Commit `.e2e/cache/`.
- Never put secrets in tests; use `credentials.user()`.
