# Quick start

Get the full memory system running in one command.

## 1. Clone and install

```bash
git clone https://github.com/robinbril/infinite-agent-memory
cd infinite-agent-memory

# macOS / Linux
bash install.sh --with-skills

# Windows (PowerShell)
pwsh install.ps1 -WithSkills
```

The installer creates `~/agent-memory/`, merges the three hooks into `~/.claude/settings.json`, copies the skill definitions and slash commands, and registers a daily distill job. No npm install needed.

The `--with-skills` flag installs agent skill definitions and `/memory-*` slash commands. Without it, only the automatic hooks (capture, recall, distill scheduling) are wired.

## 2. Verify

```bash
node scripts/doctor.js
```

Prints a PASS/WARN/FAIL report for every component. Fix any FAIL items before starting a session.

## 3. Start a session

Open Claude Code in any project directory. The memory hooks are active automatically:
- **Session start**: the memory index loads into context
- **Every prompt**: relevant pages are injected silently when they match
- **Session end**: substantial sessions are queued for distillation

## 4. Use the slash commands

With `--with-skills` installed:

```
/memory-query what do we know about the auth middleware?
/memory-ingest
/memory-lint
```

## 5. Graph and Obsidian

```bash
node graph/server.js          # wikilink graph of the memory
node graph/server.js .        # import graph of the current repo
```

Obsidian vault setup:

```bash
bash scripts/obsidian-setup.sh       # macOS / Linux
pwsh scripts/obsidian-setup.ps1      # Windows
```

## Options

Custom memory location:

```bash
bash install.sh --memory-dir /path/to/memory --with-skills
node scripts/doctor.js --memory-dir /path/to/memory
```

Preview without writing anything:

```bash
bash install.sh --dry-run --with-skills
```

Also wire Codex:

```bash
bash install.sh --with-codex --with-skills
```

## Further reading

See [README.md](README.md) for the full design, recall algorithm, maintenance scripts, and architecture.
