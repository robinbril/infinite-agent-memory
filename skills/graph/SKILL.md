---
name: graph
description: Open a localhost graph visualization of the agent memory (wikilink graph) or of any repo (import graph). Starts a zero-dependency Node server and opens the browser. Triggers include "graph", "open the graph", "show the memory graph", "visualize the memory", "knowledge graph".
allowed-tools:
  - Bash
---

# Graph: visual map of memory or repo

One server, two modes, automatically detected. The server is at `<repo>/graph/server.js` (pure Node stdlib, no installs).

## Usage

| Request | Command |
|---|---|
| Memory graph (most common) | `node <repo>/graph/server.js <memory-dir>` |
| Graph of the current repo | `node <repo>/graph/server.js .` |
| Another directory | `node <repo>/graph/server.js <path>` |

Replace `<repo>` with the absolute path to the infinite-agent-memory repository. Replace `<memory-dir>` with `$AGENT_MEMORY_DIR` or `~/agent-memory`.

Run the command with `run_in_background: true` (the server stays running). The browser opens automatically on `http://localhost:7777` (falls back to a free port; read the port from server output and report it to the user).

Set `GRAPH_NO_OPEN=1` to suppress automatic browser opening (useful in headless or subagent runs).

- **Memory mode** (directory contains .md files with `[[wikilinks]]` or frontmatter `links:`): nodes are pages colored by type (entities/concepts/summaries/sources), sized by inbound links; edges are the cross-references.
- **Repo mode** (otherwise): nodes are source files (.js/.ts/.tsx/.py/.go), edges are imports/requires. node_modules etc. are skipped, max 400 files.

In the page: pan/zoom, drag nodes, hover for neighbor highlight, click for content preview, search field top-left.

## Wrapping up

Report: the URL, the mode, and the node/edge count (from server stdout). The server stays running until the user stops it; on "stop the graph" kill the background process.
