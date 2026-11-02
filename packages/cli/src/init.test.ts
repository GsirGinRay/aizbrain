import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { before, describe, it } from "node:test";
import { BOM, builtBundles, fileSnapshot, isolatedEnv, readFile, runNode, tempDir, writeFile } from "./test-support";
import { localDateKey } from "./vault-read";

const MARKER = "<!-- aizbrain:write-back v1 -->";
const ENTRY_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "QWEN.md"];

let cli: string;
before(async () => {
  ({ cli } = await builtBundles());
});

interface Sandbox {
  home: string;
  env: NodeJS.ProcessEnv;
  vault: string;
  run: (...args: string[]) => ReturnType<typeof runNode>;
}

function sandbox(name = "vault"): Sandbox {
  const home = tempDir();
  const env = isolatedEnv(home);
  const vault = path.join(tempDir(), name);
  return { home, env, vault, run: (...args) => runNode(cli, args, { env, cwd: home }) };
}

function jsonAt(root: string, relative: string): any {
  return JSON.parse(readFile(root, relative));
}

describe("init", () => {
  it("gives a new folder an inbox and a first task, so today has an answer", () => {
    for (const [locale, inbox, title] of [["en", "Inbox/Inbox.md", "Try the handoff"], ["zh-TW", "收件匣/待辦.md", "試試 AI 交接"]] as const) {
      const { vault, run } = sandbox();
      assert.equal(run("init", vault, "--locale", locale).status, 0);
      const text = readFile(vault, inbox);
      assert.ok(text.includes(`#task ${title}`), text);
      assert.ok(text.includes(`\u{1F53A} \u{23F3} ${localDateKey(new Date())}`), text);
      assert.ok(readFile(vault, ".ai/INDEX.md").includes(title));
      assert.ok(run("today", vault).stdout.includes(title));
    }
  });

  it("does not start a second inbox next to a legacy one", () => {
    const { vault, run } = sandbox();
    writeFile(vault, "10-收件匣/待辦收件匣.md", "# 舊的\n");
    assert.equal(run("init", vault, "--locale", "zh-TW", "--yes").status, 0);
    assert.ok(!fs.existsSync(path.join(vault, "收件匣")));
    assert.equal(readFile(vault, "10-收件匣/待辦收件匣.md"), "# 舊的\n");
  });

  it("leaves an existing inbox alone and adds no first task to it", () => {
    const { vault, run } = sandbox();
    writeFile(vault, "Inbox/Inbox.md", "# Mine\n\n- [ ] #task My own task\n");
    assert.equal(run("init", vault, "--locale", "en", "--yes").status, 0);
    assert.equal(readFile(vault, "Inbox/Inbox.md"), "# Mine\n\n- [ ] #task My own task\n");
  });

  it("sets up an English vault that all default tools share", () => {
    const { vault, run, home } = sandbox();
    const out = run("init", vault, "--locale", "en");
    assert.equal(out.status, 0, out.stderr);
    for (const file of [".ai/INSTRUCTIONS.md", ".ai/INDEX.md", ".ai/bin/aizbrain-hook.mjs", ...ENTRY_FILES]) {
      assert.ok(fs.existsSync(path.join(vault, file)), file);
    }
    const instructions = readFile(vault, ".ai/INSTRUCTIONS.md");
    assert.ok(instructions.startsWith("# Second Brain — INSTRUCTIONS (Canonical)"));
    assert.ok(instructions.includes(MARKER));
    assert.ok(instructions.includes("Inbox/Inbox.md"));
    assert.ok(readFile(vault, ".ai/INDEX.md").includes("Most important today (P1): Try the handoff"));
    assert.ok(jsonAt(vault, ".claude/settings.json").hooks.Stop[0].hooks[0].command.includes("--aizbrain-hook stop"));
    assert.ok(!fs.existsSync(path.join(vault, ".gemini")), "Gemini CLI is no longer connected by default");
    assert.ok(jsonAt(vault, ".agents/hooks.json").aizbrain.Stop[0].command.endsWith("--aizbrain-hook stop --format antigravity"));
    assert.ok(out.stdout.includes("Next:"));
    assert.ok(out.stdout.includes("Codex was not touched"));
    assert.ok(!fs.existsSync(path.join(home, "codex-home")), "Codex is per user: only when listed");
  });

  it("sets up a Chinese vault in zh-TW", () => {
    const { vault, run } = sandbox();
    const out = run("init", vault, "--locale", "zh-TW");
    assert.equal(out.status, 0, out.stderr);
    const instructions = readFile(vault, ".ai/INSTRUCTIONS.md");
    assert.ok(instructions.includes("做完要寫回"));
    assert.ok(instructions.includes("收件匣/待辦.md"));
    assert.ok(readFile(vault, ".ai/INDEX.md").includes("今日最重要（P1）：試試 AI 交接"));
    assert.ok(out.stdout.includes("下一步"));
  });

  it("makes the hook usable straight away, also from a path with spaces and Chinese", () => {
    const { vault, run, env } = sandbox("my 第二 brain");
    assert.equal(run("init", vault, "--locale", "en").status, 0);
    const start = jsonAt(vault, ".claude/settings.json").hooks.SessionStart[0].hooks[0].command as string;
    assert.ok(start.startsWith('node "'), start);
    const result = spawnSync(start, { shell: true, encoding: "utf8", env, input: JSON.stringify({ session_id: "s", cwd: vault }), windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(JSON.parse(result.stdout).hookSpecificOutput.additionalContext.includes(vault.replace(/\\/g, "/")));
  });

  it("never overwrites existing files, and running it twice changes nothing", () => {
    const { vault, run } = sandbox();
    writeFile(vault, "CLAUDE.md", "# my claude rules\n");
    writeFile(vault, "AGENTS.md", `${BOM}my agents\r\n`);
    writeFile(vault, "Inbox/Inbox.md", "# mine\n- [ ] #task keep me\n");
    writeFile(vault, ".claude/settings.json", '{"permissions":{"allow":["Bash(ls)"]}}');
    const out = run("init", vault, "--locale", "en");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readFile(vault, "CLAUDE.md"), "# my claude rules\n");
    assert.equal(readFile(vault, "AGENTS.md"), `${BOM}my agents\r\n`);
    assert.equal(readFile(vault, "Inbox/Inbox.md"), "# mine\n- [ ] #task keep me\n");
    assert.ok(out.stdout.includes("CLAUDE.md"), "says the user's entry file was kept");
    const settings = jsonAt(vault, ".claude/settings.json");
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });
    assert.equal(readFile(vault, ".claude/settings.json.aizbrain-backup"), '{"permissions":{"allow":["Bash(ls)"]}}');

    const before = fileSnapshot(vault);
    const again = run("init", vault, "--locale", "en");
    assert.equal(again.status, 0, again.stderr);
    const after = fileSnapshot(vault);
    for (const [file, content] of before) {
      // Reinstalling rewrites the settings with the same content and refreshes their backup copy.
      if (!file.endsWith(".aizbrain-backup")) assert.equal(after.get(file), content, file);
    }
    assert.equal(jsonAt(vault, ".claude/settings.json").hooks.Stop.length, 1);
  });

  it("appends the write-back rules once to an older INSTRUCTIONS.md, keeping BOM and CRLF, with a backup", () => {
    const { vault, run } = sandbox();
    const old = `${BOM}# Second Brain — INSTRUCTIONS (Canonical)\r\n\r\nMy rules, read order for AI.\r\n`;
    writeFile(vault, ".ai/INSTRUCTIONS.md", old);
    const out = run("init", vault);
    assert.equal(out.status, 0, out.stderr);
    const first = readFile(vault, ".ai/INSTRUCTIONS.md");
    assert.ok(first.startsWith(old.trimEnd()));
    assert.equal(first.split(MARKER).length, 2);
    assert.ok(!/[^\r]\n/.test(first), "the added text follows the file's CRLF");
    const backups = fs.readdirSync(path.join(vault, ".ai/backups"));
    assert.equal(backups.length, 1);
    assert.equal(readFile(vault, `.ai/backups/${backups[0]}/.ai/INSTRUCTIONS.md`), old);
    assert.equal(run("init", vault).status, 0);
    assert.equal(readFile(vault, ".ai/INSTRUCTIONS.md"), first);
    assert.equal(fs.readdirSync(path.join(vault, ".ai/backups")).length, 1);
  });

  it("makes a folder with someone else's .ai rules a vault, in the language of those rules", () => {
    const { vault, run } = sandbox();
    writeFile(vault, ".ai/INSTRUCTIONS.md", "# 我們的規則\n\n請用繁體中文。\n");
    assert.equal(run("init", vault).status, 0);
    const text = readFile(vault, ".ai/INSTRUCTIONS.md");
    assert.ok(text.startsWith("# 我們的規則"));
    assert.ok(text.includes("做完要寫回"));
  });

  it("leaves an index it did not generate alone and says so", () => {
    const { vault, run } = sandbox();
    writeFile(vault, ".ai/INDEX.md", "# My own index\n");
    const out = run("init", vault, "--locale", "en");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readFile(vault, ".ai/INDEX.md"), "# My own index\n");
    assert.ok(out.stdout.includes("not made by aizbrain"));
  });

  it("--dry-run changes nothing", () => {
    const { vault, run, home } = sandbox();
    const out = run("init", vault, "--dry-run", "--locale", "en", "--tools", "claude,codex");
    assert.equal(out.status, 0, out.stderr);
    assert.ok(!fs.existsSync(vault));
    assert.ok(!fs.existsSync(path.join(home, "codex-home")));
    assert.ok(out.stdout.includes(".ai/INSTRUCTIONS.md"));

    fs.mkdirSync(vault);
    writeFile(vault, "note.md", "x");
    const before = fileSnapshot(vault);
    assert.equal(run("init", vault, "--dry-run", "--locale", "en").status, 0);
    assert.deepEqual(fileSnapshot(vault), before);
  });

  it("--no-hooks connects nothing", () => {
    const { vault, run } = sandbox();
    const out = run("init", vault, "--no-hooks", "--locale", "en");
    assert.equal(out.status, 0, out.stderr);
    assert.ok(fs.existsSync(path.join(vault, ".ai/INSTRUCTIONS.md")));
    assert.ok(!fs.existsSync(path.join(vault, ".claude")));
    assert.ok(!fs.existsSync(path.join(vault, ".ai/bin")));
  });

  it("--tools takes the Rust aliases and touches Codex's file only when listed", () => {
    const { vault, run, home } = sandbox();
    const out = run("init", vault, "--locale", "en", "--tools", "grok,gemini-cli,agy,codex");
    assert.equal(out.status, 0, out.stderr);
    assert.ok(fs.existsSync(path.join(vault, ".claude/settings.json")));
    assert.ok(fs.existsSync(path.join(vault, ".gemini/settings.json")));
    assert.ok(fs.existsSync(path.join(vault, ".agents/hooks.json")));
    const codex = JSON.parse(fs.readFileSync(path.join(home, "codex-home", "hooks.json"), "utf8"));
    assert.ok(codex.hooks.SessionStart[0].hooks[0].command.includes(".ai/bin/aizbrain-hook.mjs"));
    assert.ok(out.stdout.includes(path.join(home, "codex-home", "hooks.json")), "says which per-user file changed");
    assert.ok(!out.stdout.includes("Codex was not touched"));
  });

  it("only the listed tools get connected", () => {
    const { vault, run } = sandbox();
    assert.equal(run("init", vault, "--locale", "en", "--tools", "gemini").status, 0);
    assert.ok(fs.existsSync(path.join(vault, ".gemini/settings.json")));
    assert.ok(!fs.existsSync(path.join(vault, ".claude")));
  });

  it("reports a broken settings file, leaves it alone and connects the rest", () => {
    const { vault, run } = sandbox();
    writeFile(vault, ".agents/hooks.json", "{ not json");
    const out = run("init", vault, "--locale", "en");
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readFile(vault, ".agents/hooks.json"), "{ not json");
    assert.ok(out.stdout.includes("not valid JSON"));
    assert.ok(fs.existsSync(path.join(vault, ".claude/settings.json")));
  });

  it("refuses bad flags before changing anything", () => {
    const { vault, run } = sandbox();
    assert.equal(run("init", vault, "--tools", "cursor").status, 1);
    assert.equal(run("init", vault, "--locale", "fr").status, 1);
    assert.equal(run("init", vault, "--nope").status, 1);
    assert.ok(!fs.existsSync(vault));
  });

  it("will not set up the home folder, where tool settings apply to every project, unless told to", () => {
    const { run, home } = sandbox();
    const out = run("init", home, "--locale", "en");
    assert.equal(out.status, 1);
    assert.ok(out.stderr.includes("home folder"));
    assert.ok(!fs.existsSync(path.join(home, ".claude")));
  });

  it("refuses a link as the folder", (t) => {
    const { vault, run } = sandbox();
    const real = tempDir();
    try {
      fs.symlinkSync(real, vault, "junction");
    } catch {
      t.skip("cannot create links here");
      return;
    }
    assert.equal(run("init", vault, "--locale", "en").status, 1);
    assert.deepEqual(fs.readdirSync(real), []);
  });
});

describe("hook install and uninstall", () => {
  it("needs a vault first", () => {
    const { run } = sandbox();
    const out = run("hook", "install", "claude", tempDir());
    assert.equal(out.status, 1);
    assert.ok(out.stderr.includes("aizbrain init"));
  });

  it("connects and disconnects one tool, with aliases", () => {
    const { vault, run } = sandbox();
    assert.equal(run("init", vault, "--no-hooks", "--locale", "en").status, 0);
    assert.equal(run("hook", "install", "agy", vault).status, 0);
    assert.ok(jsonAt(vault, ".agents/hooks.json").aizbrain);
    assert.equal(run("hook", "uninstall", "antigravity", vault).status, 0);
    assert.deepEqual(jsonAt(vault, ".agents/hooks.json"), {});
    assert.ok(!fs.existsSync(path.join(vault, ".ai/bin")));
    assert.equal(run("hook", "install", "cursor", vault).status, 1);
    assert.equal(run("hook", "nonsense").status, 1);
  });

  it("reports invalid JSON and leaves it untouched", () => {
    const { vault, run } = sandbox();
    assert.equal(run("init", vault, "--no-hooks", "--locale", "en").status, 0);
    writeFile(vault, ".claude/settings.json", "{ not json");
    const out = run("hook", "install", "claude", vault);
    assert.equal(out.status, 1);
    assert.ok(out.stderr.includes("not valid JSON"));
    assert.equal(readFile(vault, ".claude/settings.json"), "{ not json");
  });

  it("the app's --aizbrain-hook install form works too", () => {
    const { vault, run } = sandbox();
    assert.equal(run("init", vault, "--no-hooks", "--locale", "en").status, 0);
    assert.equal(run("--aizbrain-hook", "install", "claude", vault).status, 0);
    assert.ok(fs.existsSync(path.join(vault, ".claude/settings.json")));
  });
});

describe("today, index and doctor", () => {
  it("today lists the P1, today's tasks, overdue tasks and handoffs", () => {
    const { vault, run } = sandbox();
    assert.equal(run("init", vault, "--no-hooks", "--locale", "en").status, 0);
    const today = localDateKey(new Date());
    writeFile(vault, "Inbox/Inbox.md", [
      "# Inbox",
      `- [ ] #task Big one 🔺 ⏳ ${today}`,
      "",
      "  ### AI work log 2026-10-24 09:00 (Codex)",
      "",
      "  - Next: review it",
      "",
      `- [ ] #task Small one ⏳ ${today} ⏰ 09:30 ⏱ 30m`,
      "- [ ] #task Old one ⏳ 2020-01-01",
      "",
    ].join("\n"));
    const before = readFile(vault, "Inbox/Inbox.md");
    const out = run("today", vault);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes("Most important: Big one"));
    assert.ok(out.stdout.includes("09:30 Small one"));
    assert.ok(out.stdout.includes("Old one"));
    assert.ok(out.stdout.includes("review it"));
    assert.equal(readFile(vault, "Inbox/Inbox.md"), before, "reading never adds ids");
  });

  it("today works from a subfolder and in Chinese, and has a friendly empty state", () => {
    const { vault, run, env } = sandbox();
    assert.equal(run("init", vault, "--no-hooks", "--locale", "zh-TW").status, 0);
    fs.mkdirSync(path.join(vault, "sub"));
    fs.rmSync(path.join(vault, "收件匣"), { recursive: true });
    const out = runNode(cli, ["today"], { env, cwd: path.join(vault, "sub") });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes("今天沒有排任務"));
    const none = run("today", tempDir());
    assert.equal(none.status, 1);
    assert.ok(none.stderr.includes("aizbrain init"));
  });

  it("index rebuilds the file and refuses someone else's", () => {
    const { vault, run } = sandbox();
    assert.equal(run("init", vault, "--no-hooks", "--locale", "en").status, 0);
    assert.ok(run("index", vault).stdout.includes("already up to date"));
    writeFile(vault, "Inbox/Inbox.md", `- [ ] #task Fresh idea\n`);
    assert.ok(run("index", vault).stdout.includes("rebuilt"));
    assert.ok(readFile(vault, ".ai/INDEX.md").includes("Fresh idea"));
    assert.equal(readFile(vault, "Inbox/Inbox.md"), "- [ ] #task Fresh idea\n");
    writeFile(vault, ".ai/INDEX.md", "# Mine\n");
    assert.equal(run("index", vault).status, 1);
    assert.equal(readFile(vault, ".ai/INDEX.md"), "# Mine\n");
  });

  it("doctor says what is set up, tool by tool", () => {
    const { vault, run } = sandbox();
    assert.equal(run("doctor", tempDir()).status, 1);
    assert.equal(run("init", vault, "--locale", "en", "--tools", "claude").status, 0);
    const out = run("doctor", vault);
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.includes("Claude Code and Grok Build: connected."));
    assert.ok(!out.stdout.includes("Gemini"));
    assert.ok(out.stdout.includes("Codex: not connected."));
    fs.rmSync(path.join(vault, ".ai/bin/aizbrain-hook.mjs"));
    assert.ok(run("doctor", vault).stdout.includes("is missing"));
  });

  it("doctor recognises the desktop app's entries", () => {
    const { vault, run } = sandbox();
    assert.equal(run("init", vault, "--no-hooks", "--locale", "en").status, 0);
    const exe = writeFile(tempDir(), "aizbrain.exe", "").replace(/\\/g, "/");
    writeFile(vault, ".claude/settings.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `"${exe}" --aizbrain-hook stop` }] }] } }));
    assert.ok(run("doctor", vault).stdout.includes("through the aizbrain desktop app"));
  });
});

describe("help and version", () => {
  it("prints them", () => {
    const { run } = sandbox();
    assert.ok(run("--help").stdout.includes("aizbrain init") || run("--help").stdout.includes("init [folder]"));
    assert.match(run("--version").stdout.trim(), /^\d+\.\d+\.\d+$/);
    assert.equal(run("nonsense").status, 1);
  });
});
