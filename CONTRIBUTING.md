# Contributing

Thanks for considering a contribution.

## Running the tests

```bash
npm test                # Node core (hooks, indexing, capture)
python -m py_compile scripts/rag/*.py          # optional Python layer compiles
python scripts/rag/pii_route.py --selftest     # PII routing self-test
```

All of these run in CI on Linux, macOS and Windows; please make sure they pass locally before opening a PR.

## Guidelines

- Keep changes surgical: one concern per PR.
- The Node core must keep working without the Python layer installed; the dense layer is opt-in and must always fall back to BM25.
- Shell scripts come in pairs: if you touch `install.sh`, mirror the change in `install.ps1` (same for the distill scripts).
- Use conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Never commit real memory data, gazetteer files or vector indexes; the `.gitignore` guards these, keep it that way.

## Reporting issues

Use the issue templates. For bugs, include your OS, Node version, and the output of `npm run doctor`.
