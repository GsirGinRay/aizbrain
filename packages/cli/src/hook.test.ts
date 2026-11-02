import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, describe, it } from "node:test";
import { scaffoldTemplateFiles } from "@second-brain/brain-core";
import { countWorklogs, findVaultRoot, QUIET, runAntigravityHook, runHook, type HookOutcome } from "./hook";
import { builtBundles, fileSnapshot, isolatedEnv, readFile, runNode, tempDir, writeFile } from "./test-support";
import { localDateKey } from "./vault-read";

const INSTRUCTIONS = ".ai/INSTRUCTIONS.md";
const INDEX = ".ai/INDEX.md";
const WORKLOG_DIR = ".ai/worklog";
const INBOX = "收件匣/待辦.md";

function vault(chinese: boolean): string {
  const root = tempDir();
  writeFile(root, INSTRUCTIONS, chinese
    ? "# Second Brain — INSTRUCTIONS（正本 / Canonical）\n\n## 做完要寫回（Write back）\n"
    : "# My own rules\n\n<!-- aizbrain:write-back v1 -->\n## Write back when you finish\n");
  writeFile(root, INDEX, "# Index\n\n## Today's tasks 今日任務（2026-10-25）\n\n今日最重要（P1）：整理法說會重點\n\n## Recent AI handoffs 最近 AI 交接\n\n| 時間 | 工具 | 任務 | 下一步 | 路徑 |\n| --- | --- | --- | --- | --- |\n| 2026-10-24 21:10 | Claude Code | 整理法說會重點 | 追 AI 伺服器需求 | 收件匣/待辦.md |\n\n## Unscheduled ideas\n");
  writeFile(root, INBOX, "- [ ] #task 整理法說會重點\n");
  return root;
}

function input(root: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ session_id: "s-1", cwd: path.join(root, "收件匣"), ...extra });
}

function antigravityInput(root: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ conversationId: "conv-1", workspacePaths: [root], modelName: "auto", ...extra });
}

const later = (start: number) => start + 5000;

/** A real vault, as `init` scaffolds it. */
function scaffolded(locale: "en" | "zh-TW"): string {
  const root = tempDir();
  for (const [relative, content] of Object.entries(scaffoldTemplateFiles(["ai"], { locale }))) writeFile(root, relative, content);
  return root;
}

describe("hook: ported from ai_hook.rs", () => {
  it("outside a vault the hook does nothing", () => {
    const dir = tempDir();
    const state = tempDir();
    // Shared AI rules in a `.ai/` folder the app did not write.
    writeFile(dir, INSTRUCTIONS, "# Shared rules\n");
    const raw = JSON.stringify({ session_id: "s", cwd: dir });
    assert.deepEqual(runHook("session-start", raw, state, Date.now()), QUIET);
    assert.deepEqual(runHook("stop", raw, state, Date.now()), QUIET);
    assert.equal(runHook("stop", "not json", state, Date.now()).exitCode, 0);
  });

  it("session start hands the AI today's P1 and recent handoffs", () => {
    const root = vault(true);
    const state = tempDir();
    const out = runHook("session-start", input(root), state, Date.now());
    const reply = JSON.parse(out.stdout);
    const context = reply.hookSpecificOutput.additionalContext as string;
    assert.equal(reply.hookSpecificOutput.hookEventName, "SessionStart");
    assert.ok(context.includes("今日最重要（P1）：整理法說會重點"));
    assert.ok(context.includes("| 2026-10-24 21:10 | Claude Code |"));
    assert.ok(context.includes("做完要寫回"));
    assert.ok(fs.statSync(path.join(state, "s-1.json")).isFile());
  });

  it("a question-only turn is not interrupted", () => {
    const root = vault(true);
    const state = tempDir();
    const start = Date.now() + 60_000;
    runHook("session-start", input(root), state, start);
    assert.deepEqual(runHook("stop", input(root, { stop_hook_active: false }), state, later(start)), QUIET);
  });

  it("a turn that edits the vault without a work log is asked once", () => {
    const root = vault(true);
    const state = tempDir();
    const start = Date.now() - 60_000;
    runHook("session-start", input(root), state, start);
    writeFile(root, INBOX, "- [x] #task 整理法說會重點\n");
    const out = runHook("stop", input(root), state, later(start));
    assert.equal(out.exitCode, 2);
    assert.ok(out.stderr.includes("AI 工作紀錄"));
    // The continued turn, and any later stop in the session, pass.
    assert.equal(runHook("stop", input(root, { stopHookActive: true }), state, later(start)).exitCode, 0);
    assert.equal(runHook("stop", input(root), state, later(start)).exitCode, 0);
  });

  it("a new work log lets the turn end", () => {
    const root = vault(false);
    const state = tempDir();
    const start = Date.now() - 60_000;
    writeFile(root, INBOX, "- [ ] #task A\n\n  ### AI work log 2026-10-24 09:00 (Codex)\n");
    runHook("session-start", input(root), state, start);
    writeFile(root, INBOX, "- [x] #task A\n\n  ### AI work log 2026-10-24 09:00 (Codex)\n\n  ### AI work log 2026-10-25 10:42 (Claude Code)\n  - Next: x\n");
    assert.deepEqual(runHook("stop", input(root), state, later(start)), QUIET);
  });

  it("a log in the worklog folder counts and Grok shutdown stops pass", () => {
    const root = vault(false);
    const state = tempDir();
    const start = Date.now() - 60_000;
    runHook("session-start", input(root), state, start);
    writeFile(root, INBOX, "- [x] #task 整理法說會重點\n");
    assert.equal(runHook("stop", input(root, { reason: "shutdown" }), state, later(start)).exitCode, 0);
    writeFile(root, `${WORKLOG_DIR}/2026-10.md`, "### AI work log 2026-10-25 10:42 (Gemini CLI)\n");
    assert.equal(runHook("stop", input(root), state, later(start)).exitCode, 0);
  });

  it("work log headings are counted in both languages", () => {
    const text = "### AI 工作紀錄 2026-10-25 10:42（Codex）\n  #### ai work log 2026-10-25 (x)\n# AI work log too shallow\n##### AI work log too deep\nAI 工作紀錄 not a heading\n";
    assert.equal(countWorklogs(text), 2);
  });

  it("Antigravity gets context as injected steps and continue to write back", () => {
    const root = vault(true);
    const state = tempDir();
    const start = Date.now() - 60_000;
    const opened = runAntigravityHook("session-start", antigravityInput(root), state, start);
    const reply = JSON.parse(opened.stdout);
    assert.ok((reply.injectSteps[0].systemMessage.systemMessage as string).includes("今日最重要（P1）：整理法說會重點"));
    writeFile(root, INBOX, "- [x] #task 整理法說會重點\n");
    // A cancelled or failed turn is never held back.
    const cancelled = runAntigravityHook("stop", antigravityInput(root, { terminationReason: "USER_CANCELED" }), state, later(start));
    assert.equal(cancelled.stdout, "{}");
    const held = runAntigravityHook("stop", antigravityInput(root, { terminationReason: "NO_TOOL_CALL" }), state, later(start));
    assert.equal(held.exitCode, 0);
    const heldReply = JSON.parse(held.stdout);
    assert.equal(heldReply.decision, "continue");
    assert.ok((heldReply.reason as string).includes("AI 工作紀錄"));
    assert.equal(runAntigravityHook("stop", antigravityInput(root, { terminationReason: "NO_TOOL_CALL" }), state, later(start)).stdout, "{}");
    assert.equal(runAntigravityHook("stop", antigravityInput(tempDir()), state, later(start)).stdout, "{}");
    assert.equal(runAntigravityHook("stop", "not json", state, later(start)).stdout, "{}");
  });
});

describe("hook: vault detection and session id", () => {
  it("finds the vault from a subfolder, by heading or by marker", () => {
    const zh = vault(true);
    const en = vault(false);
    assert.equal(findVaultRoot(path.join(zh, "收件匣")), zh);
    assert.equal(findVaultRoot(en), en);
  });

  it("uses CLAUDE_PROJECT_DIR when the input has no cwd", () => {
    const root = vault(false);
    const state = tempDir();
    process.env.CLAUDE_PROJECT_DIR = root;
    try {
      const out = runHook("session-start", JSON.stringify({ session_id: "s" }), state, Date.now());
      assert.ok(out.stdout.includes("additionalContext"));
    } finally {
      delete process.env.CLAUDE_PROJECT_DIR;
    }
  });

  it("cleans the session id into a safe file name, and an id with nothing left keeps no state", () => {
    const root = vault(false);
    const state = tempDir();
    runHook("session-start", JSON.stringify({ session_id: "../../evil id", cwd: root }), state, Date.now());
    assert.deepEqual(fs.readdirSync(state), ["evilid.json"]);
    const empty = tempDir();
    runHook("session-start", JSON.stringify({ session_id: "../..", cwd: root }), empty, Date.now());
    assert.deepEqual(fs.readdirSync(empty), []);
  });

  it("removes state files older than a week", () => {
    const root = vault(false);
    const state = tempDir();
    const old = writeFile(state, "old.json", "{}");
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, stale, stale);
    runHook("session-start", input(root), state, Date.now());
    assert.deepEqual(fs.readdirSync(state).sort(), ["s-1.json"]);
  });
});

describe("hook: refreshing the index without the app", () => {
  it("session start rebuilds an out-of-date index and touches no other file", () => {
    const root = scaffolded("en");
    const today = localDateKey(new Date());
    // No id on the task: the desktop would add one, the hook must not.
    writeFile(root, "Inbox/Inbox.md", `# Inbox\n\n- [ ] #task Ship the report 🔺 ⏳ ${today}\n\n  ### AI work log 2026-10-24 09:00 (Codex)\n\n  - Next: ask for review\n`);
    const before = fileSnapshot(root);
    const out = runHook("session-start", input(root), tempDir(), Date.now());
    const context = JSON.parse(out.stdout).hookSpecificOutput.additionalContext as string;
    assert.ok(context.includes("Most important today (P1): Ship the report"));
    assert.ok(context.includes("ask for review"), "a log under a task without an id must reach the handoffs");
    const after = fileSnapshot(root);
    assert.notEqual(after.get(INDEX), before.get(INDEX));
    for (const [file, content] of before) if (file !== INDEX) assert.equal(after.get(file), content, file);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
  });

  it("leaves the file alone when only the time stamp would change", () => {
    const root = scaffolded("zh-TW");
    const state = tempDir();
    const now = Date.now();
    runHook("session-start", input(root), state, now);
    const first = readFile(root, INDEX);
    assert.ok(first.includes("Generated at:"));
    runHook("session-start", input(root), state, now + 1000);
    assert.equal(readFile(root, INDEX), first);
  });

  it("does not touch an index aizbrain did not generate", () => {
    const root = vault(true);
    const before = readFile(root, INDEX);
    runHook("session-start", input(root), tempDir(), Date.now());
    assert.equal(readFile(root, INDEX), before);
  });

  it("fails open when the vault cannot be scanned", () => {
    const root = scaffolded("en");
    const project = "---\ntype: project\nid: same\nstatus: active\n---\n# One\n";
    writeFile(root, "Projects/a.md", project);
    writeFile(root, "Projects/b.md", project);
    const before = readFile(root, INDEX);
    const out = runHook("session-start", input(root), tempDir(), Date.now());
    assert.equal(out.exitCode, 0);
    assert.equal(out.stderr, "");
    assert.ok(out.stdout.includes("additionalContext"));
    assert.equal(readFile(root, INDEX), before);
  });
});

describe("hook: the bundled script as a tool runs it", () => {
  let script: string;
  let cli: string;
  before(async () => {
    ({ hook: script, cli } = await builtBundles());
  });

  const run = (args: string[], stdin: string, home: string) => runNode(script, args, { env: isolatedEnv(home), input: stdin, cwd: home });
  const quiet = (result: Pick<HookOutcome, "stdout" | "stderr"> & { status: number | null }) => {
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  };

  it("keeps the exit-code contract: exit 2 and a reason on stderr means keep working", () => {
    const root = vault(false);
    const home = tempDir();
    const opened = run(["--aizbrain-hook", "session-start"], input(root), home);
    assert.equal(opened.status, 0);
    assert.ok(JSON.parse(opened.stdout).hookSpecificOutput.additionalContext.includes(root.replace(/\\/g, "/")));
    const unchanged = run(["--aizbrain-hook", "stop"], input(root), home);
    quiet(unchanged);
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(writeFile(root, INBOX, "- [x] #task done\n"), future, future);
    const held = run(["--aizbrain-hook", "stop"], input(root), home);
    assert.equal(held.status, 2);
    assert.equal(held.stdout, "");
    assert.ok(held.stderr.includes("AI work log"));
    quiet(run(["--aizbrain-hook", "stop"], input(root), home));
  });

  it("translates for Antigravity with --format antigravity", () => {
    const root = vault(false);
    const home = tempDir();
    const opened = run(["--aizbrain-hook", "session-start", "--format", "antigravity"], antigravityInput(root), home);
    assert.equal(opened.status, 0);
    assert.ok(JSON.parse(opened.stdout).injectSteps[0].systemMessage.systemMessage.includes("second brain"));
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(writeFile(root, INBOX, "- [x] #task done\n"), future, future);
    const held = run(["--aizbrain-hook", "stop", "--format", "antigravity"], antigravityInput(root, { terminationReason: "NO_TOOL_CALL" }), home);
    assert.equal(held.status, 0);
    assert.equal(JSON.parse(held.stdout).decision, "continue");
    assert.equal(run(["--aizbrain-hook", "stop", "--format", "antigravity"], "garbage", home).stdout, "{}");
  });

  it("is silent on input it cannot understand, and outside a vault", () => {
    const home = tempDir();
    quiet(run(["--aizbrain-hook", "session-start"], "not json", home));
    quiet(run(["--aizbrain-hook", "stop"], "", home));
    quiet(run(["--aizbrain-hook", "stop"], "[1,2]", home));
    quiet(run(["--aizbrain-hook", "session-start"], JSON.stringify({ session_id: "x", cwd: tempDir() }), home));
  });

  it("does nothing when no state folder can be named, like the Rust hook", () => {
    const root = vault(false);
    const home = tempDir();
    const env = isolatedEnv(home);
    delete env.LOCALAPPDATA;
    delete env.HOME;
    const result = runNode(script, ["--aizbrain-hook", "session-start"], { env, input: input(root) });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  });

  it("answers an unknown event with usage and exit 1", () => {
    const result = run(["--aizbrain-hook", "nonsense"], "", tempDir());
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("usage"));
  });

  it("runs the same through the main command", () => {
    const root = vault(false);
    const home = tempDir();
    const result = runNode(cli, ["--aizbrain-hook", "session-start"], { env: isolatedEnv(home), input: input(root) });
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("additionalContext"));
  });

  it("carries no third-party code", () => {
    assert.ok(!fs.readFileSync(script, "utf8").includes("ZodError"));
    assert.ok(!fs.readFileSync(cli, "utf8").includes("ZodError"));
  });
});
