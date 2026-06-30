# Dense recall layer (optional)

An opt-in upgrade that adds **local embeddings** on top of the BM25 core. The
core stays the default: plain markdown, zero-dependency Node hooks, no Python.
This module bolts a dense retrieval layer onto it for memories where lexical
overlap alone misses paraphrased queries.

Everything here is local. No external API, no data leaving the machine. If the
embed service is down or the index is missing, the recall hook falls straight
back to BM25, so turning this on can never break recall.

## What it adds

| Piece | What it does |
|---|---|
| `embed_server.py` | Keeps a multilingual MiniLM model warm and serves embeddings on `127.0.0.1:11435`. ~20ms per query. |
| `build_index.py` | Embeds every page (entities/concepts/summaries) into `<memory>/_vec.json`. mtime-incremental: only re-embeds changed pages. |
| `pii_route.py` | Splits the distill batch by PII load: high-PII sessions stay local, low-PII sessions get a pseudonymized copy safe for a cloud model. Eleven-proof BSN detection, name gazetteer, structural guards. |
| `ollama_distill.py` | The local route: distills high-PII sessions through a local Ollama model into `<memory>/people/`. Sends nothing out. |
| `autoorder.py` | Nightly: auto-tags frontmatter, clusters pages by cosine similarity, rewrites `index.md` into themed sections, writes link suggestions and a hygiene (dupe/stale) report. Touches frontmatter only, never the body. |
| `ingest_watch.py` | Turns raw files dropped in `<memory>/raw/` into structured `sources/` pages. No LLM. |
| `lint.py` | Mechanical health check: orphans, index gaps, broken wikilinks, stale pages. Desktop notification when issues pile up. |

The dense fusion itself lives in the core hook (`hooks/prompt-recall.js`),
gated behind an env flag. This module supplies the service and the vector
index it reads.

## How the fusion works

With the dense layer on, `prompt-recall.js`:

1. Runs the normal field-weighted BM25 scoring (unchanged).
2. Embeds the prompt via the local service and computes cosine against every
   page vector in `_vec.json`.
3. Fuses the two rankings with reciprocal-rank fusion (RRF). A page is injected
   if it clears EITHER the strict BM25 gate (on-topic + score >= 0.30) OR a
   cosine above the dense floor (0.42). This lets a semantically-relevant page
   that shares no keywords with the prompt still surface.

Off (the default), the hook is byte-for-byte the proven BM25 behaviour.

## Install

Requires Python 3.10+ on PATH.

```bash
pip install fastembed numpy
```

`fastembed` downloads the embedding model on first use (a few hundred MB,
cached under your home dir). The default model is
`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` (384d, English +
many other languages). Override it with `AGENT_MEMORY_EMBED_MODEL`.

`numpy` is only needed for `autoorder.py` (the clustering). The embed service,
index build, and PII route run without it.

## Activate

1. **Build the vector index** (run once, then on a schedule):

   ```bash
   python scripts/rag/build_index.py
   ```

2. **Start the embed service** (keep it running; wire it into autostart):

   ```bash
   python scripts/rag/embed_server.py
   # health check:
   curl http://127.0.0.1:11435/health   # -> {"ok": true, "model": "...", "dim": 384}
   ```

3. **Turn on dense fusion** in the recall hook by setting the env flag. Add it
   to the `env` block of `~/.claude/settings.json` (so hooks see it) and/or your
   shell profile:

   ```json
   { "env": { "AGENT_MEMORY_DENSE": "1" } }
   ```

   Without this flag the hook ignores the dense layer entirely.

That is the whole activation. The remaining scripts (`pii_route`,
`ollama_distill`, `autoorder`, `ingest_watch`, `lint`) are independent
maintenance jobs you schedule as you like.

## Environment variables

| Var | Default | Used by |
|---|---|---|
| `AGENT_MEMORY_DIR` | `~/agent-memory` | all scripts + the hook |
| `AGENT_MEMORY_DENSE` | unset (off) | the recall hook (`1`/`true` enables fusion) |
| `AGENT_MEMORY_EMBED_MODEL` | MiniLM-L12-v2 | embed service, index build, autoorder |
| `AGENT_MEMORY_EMBED_HOST` | `127.0.0.1` | embed service |
| `AGENT_MEMORY_EMBED_PORT` | `11435` | embed service |
| `AGENT_MEMORY_EMBED_URL` | `http://127.0.0.1:11435/embed` | the recall hook |

## PII routing and the gazetteer

`pii_route.py` reads `<memory>/_distill-batch.md` (the same batch the core
distill consumes) and splits each session by PII load:

- **>= 2 PII hits** -> `<memory>/_distill-batch-local.md` (keep on the machine,
  distill via `ollama_distill.py`).
- **< 2 hits** -> `<memory>/_distill-batch-remote.md`, pseudonymized (names ->
  `[PERSON_n]`, BSN/email/phone redacted) and safe for a cloud model.

The name **gazetteer is loaded from a local file you provide**, never from
source:

```bash
cp scripts/rag/_pii-gazetteer.example.txt "$AGENT_MEMORY_DIR/_pii-gazetteer.txt"
# then edit it: one real name per line
```

`_pii-gazetteer.txt` is gitignored and never committed. The example ships with
fictive placeholder names. Detection beyond the gazetteer always runs: a
capitalized-name-pair heuristic, an eleven-proof BSN check, and structural
guards that stop UUIDs / ISO dates / URLs from being mistaken for a BSN.

Pseudonymization is stable via `<memory>/_pii-map.json` (also gitignored): the
same name maps to the same `[PERSON_n]` across runs. Self-test it:

```bash
python scripts/rag/pii_route.py --selftest
```

## Scheduling

Pick whatever runner your OS has. Stagger the jobs so each gets an exclusive
window. A typical nightly order: ingest -> build index -> autoorder, with lint
weekly.

### cron (macOS / Linux)

```cron
# m h dom mon dow   command   (set AGENT_MEMORY_DIR if not the default)
30 7 * * *  /usr/bin/python3 /path/to/repo/scripts/rag/pii_route.py
50 7 * * *  /usr/bin/python3 /path/to/repo/scripts/rag/ingest_watch.py --once
55 7 * * *  /usr/bin/python3 /path/to/repo/scripts/rag/build_index.py
10 8 * * *  /usr/bin/python3 /path/to/repo/scripts/rag/autoorder.py --once
30 8 * * 1  /usr/bin/python3 /path/to/repo/scripts/rag/lint.py --once
```

Run the embed service as a persistent user service (systemd `--user` unit or a
launchd agent) rather than from cron, so it stays warm:

```ini
# ~/.config/systemd/user/agent-memory-embed.service
[Unit]
Description=Agent memory embed service
[Service]
ExecStart=/usr/bin/python3 /path/to/repo/scripts/rag/embed_server.py
Restart=on-failure
[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now agent-memory-embed.service
```

### Task Scheduler (Windows)

```powershell
$py = (Get-Command python).Source
$repo = 'C:\path\to\repo'

function New-MemTask($name, $script, $extra, $trigger) {
  $arg = "`"$repo\scripts\rag\$script`" $extra"
  $a = New-ScheduledTaskAction -Execute $py -Argument $arg
  $s = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $name -Action $a -Trigger $trigger -Settings $s -Force
}

New-MemTask 'Memory-PII-daily'      'pii_route.py'    ''        (New-ScheduledTaskTrigger -Daily -At 07:30)
New-MemTask 'Memory-Ingest-daily'   'ingest_watch.py' '--once'  (New-ScheduledTaskTrigger -Daily -At 07:50)
New-MemTask 'Memory-VecIndex-daily' 'build_index.py'  ''        (New-ScheduledTaskTrigger -Daily -At 07:55)
New-MemTask 'Memory-AutoOrder-daily''autoorder.py'    '--once'  (New-ScheduledTaskTrigger -Daily -At 08:10)
New-MemTask 'Memory-Lint-weekly'    'lint.py'         '--once'  (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 08:30)
```

Start the embed service at logon with a separate task that runs
`pythonw.exe scripts\rag\embed_server.py` (use `pythonw` so it has no console
window), triggered `-AtLogOn`.

## Files written into the memory dir

All gitignored, all local:

| File | What |
|---|---|
| `_vec.json` | page embeddings (the dense index) |
| `_pii-gazetteer.txt` | your real names list (you create this) |
| `_pii-map.json` | stable name -> `[PERSON_n]` mapping |
| `_distill-batch-local.md` / `_distill-batch-remote.md` | the PII split |
| `_link-suggestions.json` | autoorder cross-link candidates (never auto-applied) |
| `_hygiene-report.md` | autoorder dupe / stale report |
| `_server.log` | embed service log |
| `_logs/` | lint + egress logs |

## A note on `autoorder.py` and `index.md`

`autoorder.py` rewrites `index.md` into cosine-clustered, themed sections (and
keeps a one-time `index.md.bak`). That is a different index style than the
core's `scripts/build-index.js` (which lists pages per source directory). Use
one or the other for index generation, not both: pick `autoorder.py` if you
want the clustered view, otherwise stick with `build-index.js`. The recall hook
does not depend on either; it reads the pages directly.
