# Quick start

Get up and running in one command.

## 1. Clone and install

```bash
git clone https://github.com/your-org/infinite-agent-memory
cd infinite-agent-memory
bash install.sh          # macOS / Linux
```

```powershell
# Windows (PowerShell)
pwsh install.ps1
```

The installer creates `~/agent-memory/`, merges the three hooks into
`~/.claude/settings.json`, and registers a daily distill job. No npm install
needed.

## 2. Verify

```bash
node scripts/doctor.js
```

Prints a PASS/WARN/FAIL report for every component. Fix any FAIL items before
starting a session.

## 3. Start a session

Open Claude Code in any project directory. The memory hooks are active
automatically. Session recall happens at startup; prompt recall fires
silently on every prompt; capture queues substantial sessions at end.

## Options

Custom memory location:

```bash
bash install.sh --memory-dir /path/to/memory
# then:
node scripts/doctor.js --memory-dir /path/to/memory
```

Preview without writing anything:

```bash
bash install.sh --dry-run
```

Also wire Codex:

```bash
bash install.sh --with-codex
```

## Graph and Obsidian

```bash
node graph/server.js          # wikilink graph of the memory
node graph/server.js .        # import graph of the current repo
```

Obsidian vault setup (registers the memory as a vault with the graph plugin):

```bash
bash scripts/obsidian-setup.sh       # macOS / Linux
pwsh scripts/obsidian-setup.ps1      # Windows
```

## Further reading

See [README.md](README.md) for the full design, manual install instructions,
maintenance scripts, and design rationale.
