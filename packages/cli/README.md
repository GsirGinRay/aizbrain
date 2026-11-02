# aizbrain

One shared, local memory for your AI coding tools. Run one command in any folder, and Claude Code, Codex, Gemini CLI and Antigravity all start from the same plan and leave notes for each other. It is plain Markdown: no account, no cloud, no database, and no desktop app required.

```bash
npx aizbrain init my-brain
```

Then open that folder in your AI tool and ask "What should I work on today?" When you switch tools, the next AI picks up where the last one stopped.

## What it does

- Adds `.ai/INSTRUCTIONS.md`, `.ai/INDEX.md` and the files each AI tool looks for (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `QWEN.md`). Your existing files are kept.
- At the start of a session, tells the AI today's most important task and the latest handoffs.
- When the AI changed files but left no work log, asks it once to write one. It never reads your conversations.
- Works without the network: the hook is one script in `.ai/bin`, and anything it cannot read lets your tool carry on.

## Commands

| Command | What it does |
| --- | --- |
| `aizbrain init [folder]` | Set up a folder. Options: `--locale en\|zh-TW`, `--tools claude,gemini,antigravity,codex`, `--no-hooks`, `--dry-run`, `--yes` |
| `aizbrain today [folder]` | Today's most important task, today's tasks and recent handoffs |
| `aizbrain index [folder]` | Rebuild `.ai/INDEX.md` |
| `aizbrain doctor [folder]` | What is set up, tool by tool |
| `aizbrain hook install\|uninstall <tool> [folder]` | Connect or disconnect one tool |
| `aizbrain mcp [--vault folder]` | Run the MCP server |

`claude` also covers Grok Build, which reads the same settings file.

Codex keeps its hook settings per user, not per folder, so `init` only changes `~/.codex/hooks.json` (or `$CODEX_HOME/hooks.json`) when you list `codex` yourself. The hook does nothing outside a vault. In Codex, type `/hooks` once to review and trust it.

## MCP server

For apps without hooks, such as Claude Desktop. Tools: `get_today`, `search_tasks`, `list_projects`, `add_task`, `complete_task`, `add_work_log`.

Claude Code:

```bash
claude mcp add aizbrain -- npx -y aizbrain mcp --vault /path/to/my-brain
```

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aizbrain": {
      "command": "npx",
      "args": ["-y", "aizbrain", "mcp", "--vault", "/path/to/my-brain"]
    }
  }
}
```

On Windows, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "aizbrain", "mcp", "--vault", "C:\\path\\to\\my-brain"]`.

## Your files are safe

- Writes stay inside the vault folder. Links, junctions, hidden folders and technical folders are refused.
- Before changing a Markdown file, aizbrain saves a checked copy in `.ai/backups` (the newest 50 are kept), and it refuses to write if the file changed in the meantime.
- Only the lines it adds or changes differ: BOM, line endings, indentation, unknown tokens and your other text stay as they were.

The [aizbrain desktop app](https://aizbrain.com) adds a calendar, a board and more on top of the same Markdown files. It is optional, and the two work together.

Requires Node.js 20 or newer. MIT license.
