---
name: memory-query
description: Answer a question using only the agent memory knowledge base, cite every claim to a page, then file the answer as a reusable synthesis. Usage: /memory-query <question>
---

# /memory-query

Answer a question using the agent memory, then file the answer as a synthesis page.

## Usage

`/memory-query <question>`

## Steps

1. Read `<memory-dir>/index.md` to find relevant pages
2. Read the relevant pages (sources, entities, concepts, prior syntheses)
3. Synthesize an answer grounded in memory content
4. Cite every claim: `(see [[slug]])` inline
5. Note gaps: "The memory doesn't cover X yet"
6. Save the answer to `<memory-dir>/summaries/<slug>.md` with proper frontmatter
7. Link the new synthesis from any entity/concept pages it references
8. Update `<memory-dir>/index.md` with a one-line entry

Where `<memory-dir>` is `$AGENT_MEMORY_DIR` or `~/agent-memory`.

## Rules

- Do not answer from training data. Only use what is in the memory.
- If the memory is silent on something, say so explicitly.
- Every factual claim needs a citation to a memory page.
- Filed syntheses accumulate. Future queries can reference them.
