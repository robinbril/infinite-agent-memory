# Obsidian integration

Open the agent-memory as an Obsidian vault to get a live graph of every `[[wikilink]]` in the knowledge base: entities and concepts connected by their cross-references, colored by type, sized by inbound links.

No plugin or export needed. Obsidian reads plain markdown out of the box; the `[[slug]]` links the distiller writes feed the native graph view automatically.

## Setup

### Windows

```powershell
.\scripts\obsidian-setup.ps1
```

Override the default `~/agent-memory`:

```powershell
.\scripts\obsidian-setup.ps1 -MemoryDir D:\my-memory
```

Or set `AGENT_MEMORY_DIR` in your environment and pass the same path.

The script:
- creates `<memory-dir>/.obsidian/app.json` with `useMarkdownLinks: false` (keeps `[[slug]]` syntax so links appear in graph view)
- adds the graph core plugin to `.obsidian/core-plugins.json`
- registers the vault in `%APPDATA%\obsidian\obsidian.json` (BOM-free, required by Obsidian's parser)
- patches any `Obsidian*.lnk` shortcuts on Start Menu and Desktop with `--disable-gpu-sandbox`

### macOS

```bash
bash scripts/obsidian-setup.sh
```

### Linux

```bash
bash scripts/obsidian-setup.sh
```

Custom path on macOS/Linux:

```bash
MEMORY_DIR=/path/to/memory bash scripts/obsidian-setup.sh
```

The shell script registers the vault in the OS-correct global config:
- macOS: `~/Library/Application Support/obsidian/obsidian.json`
- Linux: `~/.config/obsidian/obsidian.json`

Both scripts are idempotent; run them again after a memory-dir change or an Obsidian update without side effects.

## Using the graph

Open Obsidian. The vault appears in the vault switcher (bottom-left). Inside the vault:

- **Graph view**: `Ctrl+G` (Windows/Linux) or `Cmd+G` (macOS)
- Nodes are colored by folder (`entities/`, `concepts/`, `summaries/`, `sources/`)
- Node size reflects inbound link count: high-traffic pages are visually larger
- Click a node to open the page; type in the search bar to filter

The graph updates each time the distiller writes new pages or adds links to existing ones.

## Windows GPU-sandbox crash (Intel Arc iGPU)

On Windows with an Intel Arc integrated GPU, Obsidian (Electron/Chromium) may crash shortly after launch: the app starts, runs for about 30 seconds, then closes without ever showing the vault. The GPU child process dies with a sandbox fault.

Fix: start Obsidian with `--disable-gpu-sandbox`.

The setup script patches `Obsidian*.lnk` shortcuts on the Start Menu and Desktop automatically. If you have a custom shortcut elsewhere, add the flag to the target argument manually:

```
"C:\Users\<you>\AppData\Local\Obsidian\Obsidian.exe" --disable-gpu-sandbox
```

After a Squirrel (auto-updater) update, the shortcut may be recreated without the flag. If Obsidian starts crashing again after an update, re-run `obsidian-setup.ps1` to re-patch it.

## Verify the vault loaded

After opening Obsidian and switching to the vault, check that `.obsidian/workspace.json` exists and its modification time is recent (within the last minute):

```powershell
# Windows
Get-Item "$env:USERPROFILE\agent-memory\.obsidian\workspace.json" | Select-Object LastWriteTime
```

```bash
# macOS / Linux
ls -l ~/agent-memory/.obsidian/workspace.json
```

If `workspace.json` is missing or has an old timestamp, Obsidian did not finish loading the vault. On Windows, check for the GPU crash first (re-apply `--disable-gpu-sandbox`). On any OS, confirm `app.json` has `"useMarkdownLinks":false` and the vault appears in the global `obsidian.json`.
