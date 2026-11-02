/**
 * Adds and removes hook entries in each AI tool's settings file. A port of the
 * install half of the desktop's `ai_hook.rs`: both recognise an entry by the
 * `--aizbrain-hook` flag in its command, so each replaces what the other wrote.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOOK_FLAG } from "./hook";
import { atomicReplace, resolveOwnFilePath } from "./vault-fs";

export type HookTool = "claude" | "codex" | "gemini" | "antigravity";

export const VAULT_HOOK_TOOLS: readonly HookTool[] = ["claude", "antigravity"];
export const LISTED_HOOK_TOOLS: readonly HookTool[] = [...VAULT_HOOK_TOOLS, "codex"];
/** Gemini CLI is unlisted, but folders set up by 0.1.0 can still have its hooks to find and remove. */
export const ALL_HOOK_TOOLS: readonly HookTool[] = [...LISTED_HOOK_TOOLS, "gemini"];
export const HOOK_SCRIPT_PATH = ".ai/bin/aizbrain-hook.mjs";
/** The name of our entry in an Antigravity `hooks.json`. */
const ANTIGRAVITY_HOOK_NAME = "aizbrain";

export function parseHookTool(name: string): HookTool | null {
  switch (name.toLowerCase()) {
    case "claude": case "claude-code": case "grok": return "claude";
    case "codex": return "codex";
    case "gemini": case "gemini-cli": return "gemini";
    case "antigravity": case "agy": return "antigravity";
    default: return null;
  }
}

function toolEvents(tool: HookTool): [string, string][] {
  return tool === "gemini"
    ? [["SessionStart", "session-start"], ["AfterAgent", "stop"]]
    : [["SessionStart", "session-start"], ["Stop", "stop"]];
}

/** Codex skipped project hook files in testing, so its file is per user. */
export function hookConfigPath(tool: HookTool, vault: string): string {
  switch (tool) {
    case "claude": return path.join(vault, ".claude", "settings.json");
    case "gemini": return path.join(vault, ".gemini", "settings.json");
    case "antigravity": return path.join(vault, ".agents", "hooks.json");
    case "codex": return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "hooks.json");
  }
}

/** Forward slashes, quoted only when the path has spaces, like `hook_command` in Rust. */
export function hookCommand(script: string, event: string): string {
  const forward = script.replace(/\\/g, "/");
  const program = forward.includes(" ") ? `"${forward}"` : forward;
  return `node ${program} ${HOOK_FLAG} ${event}`;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOurs(entry: unknown): boolean {
  if (!isObject(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((hook) => isObject(hook) && typeof hook.command === "string" && hook.command.includes(HOOK_FLAG));
}

/** `config` with our entries added (install) or removed. Everything else is kept as it was. */
export function applyHookEntries(config: unknown, tool: HookTool, script: string, install: boolean): Json {
  const root: Json = isObject(config) ? { ...config } : {};
  if (tool === "antigravity") {
    // Antigravity keys a file by hook name; events hold flat handler lists.
    if (install) {
      const handler = (event: string) => [{ type: "command", command: `${hookCommand(script, event)} --format antigravity` }];
      root[ANTIGRAVITY_HOOK_NAME] = { SessionStart: handler("session-start"), Stop: handler("stop") };
    } else {
      delete root[ANTIGRAVITY_HOOK_NAME];
    }
    return root;
  }
  const hooks: Json = isObject(root.hooks) ? { ...root.hooks } : {};
  // Keys are assigned in place, so a reinstall leaves the file exactly as it was.
  for (const [event, command] of toolEvents(tool)) {
    const current = hooks[event];
    const entries: unknown[] = Array.isArray(current) ? current.filter((entry) => !isOurs(entry)) : [];
    if (install) {
      entries.push(tool === "gemini"
        ? { matcher: "*", hooks: [{ type: "command", command: hookCommand(script, command) }] }
        : { hooks: [{ type: "command", command: hookCommand(script, command) }] });
    }
    if (entries.length > 0) hooks[event] = entries;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length > 0) root.hooks = hooks;
  else delete root.hooks;
  if (install && tool === "gemini") {
    if (!("hooksConfig" in root)) root.hooksConfig = {};
    if (isObject(root.hooksConfig) && !("enabled" in root.hooksConfig)) root.hooksConfig = { ...root.hooksConfig, enabled: true };
  }
  return root;
}

export class HookConfigError extends Error {}

/**
 * Install or remove the hook in one settings file. An existing file is copied
 * to `<file>.aizbrain-backup` first; one that is not valid JSON is left untouched.
 */
export function updateHookConfig(file: string, tool: HookTool, script: string, install: boolean): void {
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HookConfigError(`cannot read ${file}: ${(error as Error).message}`);
  }
  if (existing !== null && fs.lstatSync(file).isSymbolicLink()) throw new HookConfigError(`${file} is a link; left unchanged`);
  const text = existing?.replace(/^\uFEFF+/, "") ?? "";
  let config: unknown = {};
  if (text.trim()) {
    try {
      config = JSON.parse(text);
    } catch {
      throw new HookConfigError(`${file} is not valid JSON; left unchanged`);
    }
  }
  if (existing === null && !install) return;
  const updated = applyHookEntries(config, tool, script, install);
  // Nothing to do: above all, keep the backup of the user's own version.
  if (existing !== null && text.trim() && JSON.stringify(updated) === JSON.stringify(config)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (existing !== null) fs.copyFileSync(file, `${file}.aizbrain-backup`);
  atomicReplace(file, Buffer.from(`${JSON.stringify(updated, null, 2)}\n`, "utf8"));
}

/** The tool folders in the vault must be real folders, not links out of it. */
function assertConfigInsideVault(tool: HookTool, vault: string): void {
  if (tool === "codex") return;
  const folder = path.dirname(hookConfigPath(tool, vault));
  try {
    if (fs.lstatSync(folder).isSymbolicLink()) throw new HookConfigError(`${folder} is a link; left unchanged`);
  } catch (error) {
    if (error instanceof HookConfigError) throw error;
  }
}

/** Copy the bundled script into the vault, replacing an older copy. Returns its absolute path. */
export function installHookScript(vault: string, source: string): string {
  const target = resolveOwnFilePath(vault, HOOK_SCRIPT_PATH, { create: true });
  const bytes = fs.readFileSync(source);
  if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) atomicReplace(target, bytes);
  return target;
}

export function installHook(tool: HookTool, vault: string, scriptSource: string): string {
  assertConfigInsideVault(tool, vault);
  const script = installHookScript(vault, scriptSource);
  const file = hookConfigPath(tool, vault);
  updateHookConfig(file, tool, script, true);
  return file;
}

function mentionsScript(file: string, script: string): boolean {
  try {
    return fs.readFileSync(file, "utf8").includes(script.replace(/\\/g, "/"));
  } catch {
    return false;
  }
}

/** Remove our entries. Once no tool uses this vault's script, the script goes too. */
export function uninstallHook(tool: HookTool, vault: string): string {
  assertConfigInsideVault(tool, vault);
  const file = hookConfigPath(tool, vault);
  const script = path.join(vault, ...HOOK_SCRIPT_PATH.split("/"));
  updateHookConfig(file, tool, script, false);
  if (!ALL_HOOK_TOOLS.some((other) => mentionsScript(hookConfigPath(other, vault), script))) {
    fs.rmSync(script, { force: true });
    try {
      fs.rmdirSync(path.dirname(script));
    } catch {
      // Something else lives in the folder; leave it.
    }
  }
  return file;
}

export interface HookStatus {
  tool: HookTool;
  file: string;
  state: "connected" | "off" | "missing" | "invalid" | "broken";
  /** The program the tool runs, when connected. */
  program: string | null;
}

function commandsIn(config: Json, tool: HookTool): string[] {
  if (tool === "antigravity") {
    const named = config[ANTIGRAVITY_HOOK_NAME];
    if (!isObject(named)) return [];
    return Object.values(named).flatMap((handlers) => Array.isArray(handlers)
      ? handlers.flatMap((handler) => isObject(handler) && typeof handler.command === "string" ? [handler.command] : [])
      : []);
  }
  if (!isObject(config.hooks)) return [];
  return Object.values(config.hooks).flatMap((entries) => Array.isArray(entries)
    ? entries.flatMap((entry) => isObject(entry) && Array.isArray(entry.hooks)
      ? entry.hooks.flatMap((hook) => isObject(hook) && typeof hook.command === "string" ? [hook.command] : [])
      : [])
    : []);
}

function programOf(command: string): string | null {
  const match = /^(?:node\s+)?("?)(.+?)\1\s+--aizbrain-hook\b/.exec(command);
  return match ? match[2]! : null;
}

/** What one tool's settings file says, for `doctor`. */
export function readHookStatus(tool: HookTool, vault: string): HookStatus {
  const file = hookConfigPath(tool, vault);
  const status = (state: HookStatus["state"], program: string | null = null): HookStatus => ({ tool, file, state, program });
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8").replace(/^\uFEFF+/, "");
  } catch {
    return status("missing");
  }
  let config: unknown = {};
  try {
    if (text.trim()) config = JSON.parse(text);
  } catch {
    return status("invalid");
  }
  if (!isObject(config)) return status("invalid");
  const command = commandsIn(config, tool).find((item) => item.includes(HOOK_FLAG));
  if (!command) return status("missing");
  const program = programOf(command);
  if (program && !fs.existsSync(program)) return status("broken", program);
  if (tool === "gemini" && isObject(config.hooksConfig) && config.hooksConfig.enabled === false) return status("off", program);
  return status("connected", program);
}
