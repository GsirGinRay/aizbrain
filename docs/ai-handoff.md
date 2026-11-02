# How the AI handoff works

AIzBrain lets several AI tools work on the same task without you re-explaining anything. It does this with plain files in one folder, so there is nothing to sign up for and nothing to migrate away from.

The original design notes are in [ai-write-back-plan.md](ai-write-back-plan.md) (Traditional Chinese).

## The files

```text
my-second-brain/
├─ CLAUDE.md, AGENTS.md, GEMINI.md, QWEN.md   entry notes: "read .ai/INSTRUCTIONS.md first"
├─ .ai/
│  ├─ INSTRUCTIONS.md   the rules, including "write back when you finish"
│  ├─ INDEX.md          generated overview: today's P1, projects, overdue, recent handoffs
│  └─ worklog/          work logs that match no task
├─ Inbox/Inbox.md       your tasks
├─ Projects/            one Markdown file per project
└─ Knowledge/           notes and prompts
```

## One session

1. **Start.** The tool opens the folder and reads its entry file. If hooks are installed, a session-start hook also passes today's most important task and the latest handoffs to the AI.
2. **Work.** The AI edits ordinary Markdown.
3. **Write back.** The AI adds a log under the task:

   ```markdown
   ### AI work log 2026-11-02 21:14 (Claude Code)
   - Done: drafted the launch post
   - Result: Knowledge/Launch post.md
   - Next: tighten the intro
   ```

4. **Stop.** If the turn changed Markdown but added no log, the stop hook asks the AI once to write one. A turn that only answered a question is left alone.
5. **Next tool.** The next AI reads the same files and continues from "Next".

## Setting it up

```bash
npx aizbrain init my-second-brain     # scaffold and install hooks
npx aizbrain doctor my-second-brain   # what is connected, in plain words
npx aizbrain hook install codex my-second-brain
```

`init` never overwrites existing files. Hook settings that belong to the folder (Claude Code and Grok Build, Gemini CLI, Antigravity) are installed by default. Codex keeps its hooks in a per-user file, so `init` touches it only when you ask with `--tools codex`. Before changing a settings file, a copy is saved as `<file>.aizbrain-backup`.

The desktop app can build the same files from **Settings → Build architecture → AI handoff**. It keeps `.ai/INDEX.md` up to date while it runs. Without the app, the CLI hook refreshes that one file at session start.

## Tools without hooks

Tools such as OpenCode and Qwen Code read the entry file but get no reminder, so they rely on the rules alone. Apps that can't read a folder can connect through MCP:

```bash
npx aizbrain mcp --vault /path/to/my-second-brain
```

The MCP server offers tools to read today's priorities, search tasks, list projects, add and complete tasks, and write work logs. Every write is confined to the folder, backed up first and written atomically. A web chat with no MCP or file access can't read your folder at all.

## What the hooks can see

Hooks read the folder and never the conversation. They fail open: if anything goes wrong, the AI tool carries on as if they weren't there. Once a tool has the folder open it can read what's inside, and that tool's own terms apply.
