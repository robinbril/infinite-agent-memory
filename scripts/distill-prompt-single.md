# Per-session distill (parallel-safe)

You fold ONE completed agent session into the local memory wiki at `{{MEMORY_DIR}}`.
This runs headless alongside other parallel distill workers. Nobody is watching.

## RACE-SAFETY CONSTRAINT - read this before anything else

You share the memory directory with other workers running simultaneously.
Each worker owns exactly ONE session slug: `{{SESSION_SLUG}}`.

**You may ONLY write to these two paths:**
- `{{MEMORY_DIR}}/sources/{{SESSION_SLUG}}.md`
- `{{MEMORY_DIR}}/summaries/{{SESSION_SLUG}}.md`

**You must NOT touch:**
- `{{MEMORY_DIR}}/index.md`
- `{{MEMORY_DIR}}/entities/` (any file)
- `{{MEMORY_DIR}}/concepts/` (any file)
- Any file in `sources/` other than `sources/{{SESSION_SLUG}}.md`

The serial merge step after the parallel phase handles entities, concepts, and the index.
Your only job is the source + summary for this one session.

## Read first

1. `{{MEMORY_DIR}}/SCHEMA.md`: frontmatter rules and conventions.
2. `{{MEMORY_DIR}}/_distill-single-{{SESSION_SLUG}}.md`: the session digest (your input).

Do NOT read `index.md` or any entity/concept page. It wastes context and you are not allowed to update them.

## What to extract (durable knowledge only)

Extract only what still has value a week from now:
- **Design decisions**: what was decided, which alternatives were rejected, and why.
- **Lessons learned**: a pitfall that was hit plus the prevention rule.
- **Project facts**: architecture, endpoints, IDs, config locations, versions, names, agreements.
- **Code insights**: non-obvious patterns, gotchas, why an approach was chosen.

Ignore: small talk, dead-end debugging without an outcome, and anything that only mattered for this one session.

## What to write

### `sources/{{SESSION_SLUG}}.md`

If the session has extractable content, create this file with frontmatter and distilled text:

```yaml
---
name: {{SESSION_SLUG}}
type: source
ingested: {{DATE}}
origin: agent-session
---
```

Then 200-600 words of distilled content. NOT a raw log. Facts, decisions, lessons only.
Skip secrets (tokens, API keys, passwords, cookies). Reference their location instead.

### `summaries/{{SESSION_SLUG}}.md`

Create this file with a 5-15 bullet summary:

```yaml
---
name: {{SESSION_SLUG}}
type: summary
sources: [{{SESSION_SLUG}}]
updated: {{DATE}}
---
```

Then 5-15 bullets, each ending with `(source: {{SESSION_SLUG}})`.

If the session contains nothing durable (pure small talk, failed debug with no outcome), write both files anyway but mark them empty with a single bullet: `- No durable knowledge extracted. (source: {{SESSION_SLUG}})`.

## Hard rules

- **Never write secrets**: tokens, API keys, passwords, bearer values, cookies, service keys.
- Invent nothing. If it is not in the digest, do not write it.
- Only write the two files listed above. Nothing else.
- Do not delete `_recall-index.json`; the serial merge step handles that.

## Finish

Print one short line: `DONE {{SESSION_SLUG}}: source written, summary written.` (or `skipped` if truly empty). No further explanation.
