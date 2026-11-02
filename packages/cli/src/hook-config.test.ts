import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { applyHookEntries, hookCommand, hookConfigPath, installHook, parseHookTool, readHookStatus, uninstallHook, updateHookConfig } from "./hook-config";
import { BOM, readFile, tempDir, writeFile } from "./test-support";

const SCRIPT = "C:/a/.ai/bin/aizbrain-hook.mjs";
// `uninstallHook` looks at Codex's file too; keep that away from the real one.
process.env.CODEX_HOME = tempDir();

describe("hook config: ported from ai_hook.rs", () => {
  it("install adds only our entries and uninstall removes only them", () => {
    const script = String.raw`C:\Users\me\vault\.ai\bin\aizbrain-hook.mjs`;
    const existing = {
      permissions: { allow: ["Bash(ls)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "my-linter" }] }] },
    };
    const installed: any = applyHookEntries(existing, "claude", script, true);
    assert.deepEqual(installed.permissions, existing.permissions);
    assert.equal(installed.hooks.Stop.length, 2);
    assert.equal(installed.hooks.Stop[0].hooks[0].command, "my-linter");
    assert.equal(installed.hooks.Stop[1].hooks[0].command, "node C:/Users/me/vault/.ai/bin/aizbrain-hook.mjs --aizbrain-hook stop");
    assert.equal(installed.hooks.SessionStart[0].hooks[0].command, "node C:/Users/me/vault/.ai/bin/aizbrain-hook.mjs --aizbrain-hook session-start");
    // Installing twice does not duplicate.
    assert.deepEqual(applyHookEntries(installed, "claude", script, true), installed);
    assert.deepEqual(applyHookEntries(installed, "claude", script, false), existing);
  });

  it("Gemini uses AfterAgent and enables hooks without overriding a choice", () => {
    const installed: any = applyHookEntries({}, "gemini", SCRIPT, true);
    assert.equal(installed.hooks.AfterAgent[0].matcher, "*");
    assert.equal(installed.hooks.AfterAgent[0].hooks[0].command, `node ${SCRIPT} --aizbrain-hook stop`);
    assert.equal(installed.hooksConfig.enabled, true);
    const kept: any = applyHookEntries({ hooksConfig: { enabled: false } }, "gemini", SCRIPT, true);
    assert.equal(kept.hooksConfig.enabled, false);
  });

  it("Antigravity install owns one named hook", () => {
    const existing = { "lint-checker": { PostToolUse: [] } };
    const installed: any = applyHookEntries(existing, "antigravity", SCRIPT, true);
    assert.deepEqual(installed["lint-checker"], existing["lint-checker"]);
    assert.equal(installed.aizbrain.SessionStart[0].command, `node ${SCRIPT} --aizbrain-hook session-start --format antigravity`);
    assert.equal(installed.aizbrain.Stop[0].command, `node ${SCRIPT} --aizbrain-hook stop --format antigravity`);
    assert.deepEqual(applyHookEntries(installed, "antigravity", SCRIPT, false), existing);
  });

  it("a path with spaces is quoted", () => {
    assert.equal(
      hookCommand(String.raw`C:\Program Files\vault\aizbrain-hook.mjs`, "stop"),
      'node "C:/Program Files/vault/aizbrain-hook.mjs" --aizbrain-hook stop',
    );
    assert.equal(hookCommand("/home/me/v/aizbrain-hook.mjs", "stop"), "node /home/me/v/aizbrain-hook.mjs --aizbrain-hook stop");
  });

  it("the config file is backed up and invalid JSON is left alone", () => {
    const dir = tempDir();
    const file = path.join(dir, ".claude", "settings.json");
    updateHookConfig(file, "claude", SCRIPT, true);
    assert.ok(!fs.existsSync(`${file}.aizbrain-backup`));
    updateHookConfig(file, "claude", SCRIPT, false);
    assert.ok(fs.statSync(`${file}.aizbrain-backup`).isFile());
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {});
    fs.writeFileSync(file, "{ not json");
    assert.throws(() => updateHookConfig(file, "claude", SCRIPT, true), /not valid JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
  });

  it("uninstall with no settings file creates nothing", () => {
    const file = path.join(tempDir(), ".claude", "settings.json");
    updateHookConfig(file, "claude", SCRIPT, false);
    assert.ok(!fs.existsSync(path.dirname(file)));
  });

  it("reads a settings file with a BOM and pretty-prints with a final newline", () => {
    const dir = tempDir();
    const file = writeFile(dir, ".claude/settings.json", `${BOM}{"a":1}`);
    updateHookConfig(file, "claude", SCRIPT, true);
    const text = fs.readFileSync(file, "utf8");
    assert.ok(text.startsWith('{\n  "a": 1,'));
    assert.ok(text.endsWith("}\n"));
    assert.equal(fs.readFileSync(`${file}.aizbrain-backup`, "utf8"), `${BOM}{"a":1}`);
  });

  it("accepts the same tool names as the Rust installer", () => {
    assert.equal(parseHookTool("claude"), "claude");
    assert.equal(parseHookTool("Claude-Code"), "claude");
    assert.equal(parseHookTool("grok"), "claude");
    assert.equal(parseHookTool("codex"), "codex");
    assert.equal(parseHookTool("gemini-cli"), "gemini");
    assert.equal(parseHookTool("GEMINI"), "gemini");
    assert.equal(parseHookTool("agy"), "antigravity");
    assert.equal(parseHookTool("antigravity"), "antigravity");
    assert.equal(parseHookTool("cursor"), null);
  });
});

describe("hook config: working with the desktop app's installer", () => {
  const rustCommand = (event: string) => `C:/Users/me/AppData/Local/aizbrain/second-brain-workspace.exe --aizbrain-hook ${event}`;

  it("replaces an entry the Rust installer wrote", () => {
    const rust = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: rustCommand("session-start") }] }],
        Stop: [{ hooks: [{ type: "command", command: "my-linter" }] }, { hooks: [{ type: "command", command: rustCommand("stop") }] }],
      },
    };
    const installed: any = applyHookEntries(rust, "claude", SCRIPT, true);
    assert.equal(installed.hooks.SessionStart.length, 1);
    assert.equal(installed.hooks.SessionStart[0].hooks[0].command, `node ${SCRIPT} --aizbrain-hook session-start`);
    assert.deepEqual(installed.hooks.Stop.map((entry: any) => entry.hooks[0].command), ["my-linter", `node ${SCRIPT} --aizbrain-hook stop`]);
    const removed: any = applyHookEntries(rust, "claude", SCRIPT, false);
    assert.deepEqual(removed, { hooks: { Stop: [{ hooks: [{ type: "command", command: "my-linter" }] }] } });
  });

  it("replaces Rust's named Antigravity hook", () => {
    const rust = { aizbrain: { SessionStart: [{ type: "command", command: `${rustCommand("session-start")} --format antigravity` }] } };
    const installed: any = applyHookEntries(rust, "antigravity", SCRIPT, true);
    assert.equal(installed.aizbrain.SessionStart[0].command, `node ${SCRIPT} --aizbrain-hook session-start --format antigravity`);
    assert.ok(installed.aizbrain.Stop);
  });

  it("writes entries Rust's `is_ours` will recognise: the literal flag in the command, under hooks[].command", () => {
    const installed: any = applyHookEntries({}, "gemini", SCRIPT, true);
    for (const entries of Object.values<any[]>(installed.hooks)) {
      for (const entry of entries) {
        assert.ok(entry.hooks.some((hook: any) => typeof hook.command === "string" && hook.command.includes("--aizbrain-hook")));
      }
    }
  });
});

describe("hook config: files", () => {
  function fixture() {
    const vault = tempDir();
    const source = writeFile(tempDir(), "aizbrain-hook.mjs", "// script\n");
    return { vault, source };
  }

  it("copies the script into .ai/bin and points the command at it", () => {
    const { vault, source } = fixture();
    const file = installHook("claude", vault, source);
    assert.equal(file, path.join(vault, ".claude", "settings.json"));
    assert.equal(readFile(vault, ".ai/bin/aizbrain-hook.mjs"), "// script\n");
    const command = JSON.parse(fs.readFileSync(file, "utf8")).hooks.Stop[0].hooks[0].command as string;
    assert.equal(command, hookCommand(path.join(vault, ".ai", "bin", "aizbrain-hook.mjs"), "stop"));
    assert.equal(readHookStatus("claude", vault).state, "connected");
  });

  it("removes the script only when no tool uses it any more", () => {
    const { vault, source } = fixture();
    installHook("claude", vault, source);
    installHook("gemini", vault, source);
    uninstallHook("claude", vault);
    assert.ok(fs.existsSync(path.join(vault, ".ai/bin/aizbrain-hook.mjs")));
    uninstallHook("gemini", vault);
    assert.ok(!fs.existsSync(path.join(vault, ".ai/bin")));
  });

  it("refuses to write through a linked tool folder", (t) => {
    const { vault, source } = fixture();
    const outside = tempDir();
    try {
      fs.symlinkSync(outside, path.join(vault, ".claude"), "junction");
    } catch {
      t.skip("cannot create links here");
      return;
    }
    assert.throws(() => installHook("claude", vault, source), /link/);
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  it("uses CODEX_HOME for Codex", () => {
    const home = tempDir();
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      assert.equal(hookConfigPath("codex", "ignored"), path.join(home, "hooks.json"));
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });

  it("reports each state in plain terms", () => {
    const { vault, source } = fixture();
    assert.equal(readHookStatus("gemini", vault).state, "missing");
    installHook("gemini", vault, source);
    assert.equal(readHookStatus("gemini", vault).state, "connected");
    const file = path.join(vault, ".gemini", "settings.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.hooksConfig.enabled = false;
    fs.writeFileSync(file, JSON.stringify(config));
    assert.equal(readHookStatus("gemini", vault).state, "off");
    fs.writeFileSync(file, "{ not json");
    assert.equal(readHookStatus("gemini", vault).state, "invalid");
    installHook("claude", vault, source);
    fs.rmSync(path.join(vault, ".ai/bin/aizbrain-hook.mjs"));
    assert.equal(readHookStatus("claude", vault).state, "broken");
  });
});
