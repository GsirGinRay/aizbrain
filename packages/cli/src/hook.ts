/**
 * Lifecycle hooks for AI coding tools: a port of the desktop app's Rust
 * `ai_hook.rs`, with the same input handling, output and exit codes.
 *
 * - session-start hands the AI today's P1 and recent handoffs from `.ai/INDEX.md`.
 * - stop asks once for a work log when the turn changed Markdown without one.
 *
 * Without the app nothing else refreshes the index, so session-start also
 * regenerates `.ai/INDEX.md` when it is out of date. Apart from that the hook
 * only reads the vault, never the conversation, and it fails open: anything it
 * cannot read or understand lets the tool carry on unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { isChineseInstructions, refreshIndex, VAULT_INDEX_PATH, VAULT_INSTRUCTIONS_PATH } from "./vault-read";
import { decodeUtf8 } from "./vault-fs";

export const HOOK_FLAG = "--aizbrain-hook";
const WORKLOG_DIR = ".ai/worklog";
/** Same marker as `WRITE_BACK_MARKER` in `packages/brain-core/src/scaffold.ts`. */
const WRITE_BACK_MARKER = "<!-- aizbrain:write-back v1 -->";
const MAX_FILES = 20_000;
const MAX_DEPTH = 12;
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;

export type HookEvent = "session-start" | "stop";

/** Exit 2 with a reason on stderr is the one "keep working" signal every tool understands. */
export interface HookOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export const QUIET: Readonly<HookOutcome> = Object.freeze({ stdout: "", stderr: "", exitCode: 0 });

type Json = Record<string, unknown>;

export function stateDir(): string | null {
  const base = process.env.LOCALAPPDATA || process.env.HOME;
  return base ? path.join(base, "aizbrain", "hooks") : null;
}

function readText(file: string): string | null {
  try {
    return decodeUtf8(fs.readFileSync(file));
  } catch {
    return null;
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tools spell a field in snake_case (Claude, Codex, Gemini) or camelCase (Grok sends both). */
function field(input: Json, snake: string, camel: string): unknown {
  return input[snake] ?? input[camel];
}

function fieldString(input: Json, snake: string, camel: string): string | null {
  const value = field(input, snake, camel);
  return typeof value === "string" ? value : null;
}

/** Run one hook event. Pure apart from the vault and `stateDirectory`, for tests. */
export function runHook(event: HookEvent, rawInput: string, stateDirectory: string, nowMs: number): HookOutcome {
  const input = parseJson(rawInput);
  if (!isObject(input)) return { ...QUIET };
  const cwd = fieldString(input, "cwd", "cwd") ?? process.env.CLAUDE_PROJECT_DIR ?? process.env.GEMINI_PROJECT_DIR ?? process.cwd();
  const vault = findVaultRoot(cwd);
  if (!vault) return { ...QUIET };
  const id = fieldString(input, "session_id", "sessionId");
  const session = id === null ? null : sessionFileName(id);
  return event === "session-start"
    ? sessionStart(vault, session, stateDirectory, nowMs)
    : stop(input, vault, session, stateDirectory, nowMs);
}

/**
 * Antigravity (CLI, IDE and 2.0) sends camelCase input without a `cwd`, takes
 * context as `injectSteps`, and keeps working on `{"decision": "continue"}`
 * instead of exit 2. Translate both ways.
 */
export function runAntigravityHook(event: HookEvent, rawInput: string, stateDirectory: string, nowMs: number): HookOutcome {
  const allow: HookOutcome = { ...QUIET, stdout: "{}" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return allow;
  }
  const input = isObject(parsed) ? parsed : {};
  // Only a normal turn end may be held back; errors, cancels and limits pass.
  const termination = input.terminationReason;
  if (event === "stop" && typeof termination === "string" && termination !== "NO_TOOL_CALL") return allow;
  const normalized: Json = {};
  if (Array.isArray(input.workspacePaths) && input.workspacePaths.length > 0) normalized.cwd = input.workspacePaths[0];
  if ("conversationId" in input) normalized.session_id = input.conversationId;
  const outcome = runHook(event, JSON.stringify(normalized), stateDirectory, nowMs);
  if (event === "session-start") {
    const reply = parseJson(outcome.stdout);
    const specific = isObject(reply) ? reply.hookSpecificOutput : null;
    const context = isObject(specific) ? specific.additionalContext : null;
    if (typeof context !== "string") return allow;
    return { ...QUIET, stdout: JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: context } }] }) };
  }
  if (outcome.exitCode === 2) return { ...QUIET, stdout: JSON.stringify({ decision: "continue", reason: outcome.stderr }) };
  return allow;
}

/**
 * The nearest folder at or above `start` whose `.ai/INSTRUCTIONS.md` aizbrain
 * wrote: it starts with our heading or carries the write-back marker. Other
 * `.ai/` folders, such as a home folder's shared AI rules, are not vaults.
 */
export function findVaultRoot(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    const text = readText(path.join(current, ...VAULT_INSTRUCTIONS_PATH.split("/")));
    if (text !== null && (text.replace(/^\uFEFF+/, "").startsWith("# Second Brain — INSTRUCTIONS") || text.includes(WRITE_BACK_MARKER))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function sessionFileName(id: string): string | null {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
  return cleaned ? `${cleaned}.json` : null;
}

function isChineseVault(vault: string): boolean {
  return isChineseInstructions(readText(path.join(vault, ...VAULT_INSTRUCTIONS_PATH.split("/"))) ?? "");
}

function sessionStart(vault: string, session: string | null, stateDirectory: string, nowMs: number): HookOutcome {
  try {
    refreshIndex(vault, new Date(nowMs));
  } catch {
    // The index stays as it was; the session still starts.
  }
  if (session) {
    pruneOldStates(stateDirectory, nowMs);
    const counts: Record<string, number> = {};
    for (const [relative, file] of markdownFiles(vault)) {
      const text = readText(file);
      if (text === null) continue;
      const count = countWorklogs(text);
      if (count > 0) counts[relative] = count;
    }
    try {
      fs.mkdirSync(stateDirectory, { recursive: true });
      fs.writeFileSync(path.join(stateDirectory, session), JSON.stringify({ vault, startedMs: nowMs, counts, reminded: false }));
    } catch {
      // Without a state file the stop event simply passes.
    }
  }
  return {
    ...QUIET,
    stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: sessionContext(vault) } }),
  };
}

/** Today's P1 line and the recent-handoffs table from `.ai/INDEX.md`. */
export function sessionContext(vault: string): string {
  const chinese = isChineseVault(vault);
  const lines = (readText(path.join(vault, ...VAULT_INDEX_PATH.split("/"))) ?? "").split(/\r?\n/);
  const p1 = lines.find((line) => line.startsWith("今日最重要（P1）") || line.startsWith("Most important today (P1)"))?.trim();
  const handoffs: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      inSection = line.startsWith("## Recent AI handoffs");
      continue;
    }
    if (inSection && line.startsWith("|") && handoffs.length < 7) handoffs.push(line);
  }
  // Name the folder: other instructions the AI has loaded may point at a
  // different second brain, and this session's tasks live here.
  const root = vault.replace(/\\/g, "/");
  let out = chinese
    ? `這次工作的第二大腦（aizbrain vault）就是目前的資料夾 ${root}，任務與筆記都在這裡。先讀 .ai/INSTRUCTIONS.md，再讀 .ai/INDEX.md。\n`
    : `The second brain (aizbrain vault) for this session is the current folder ${root}; its tasks and notes are here. Read .ai/INSTRUCTIONS.md first, then .ai/INDEX.md.\n`;
  if (p1) out += `${p1}\n`;
  if (handoffs.length > 2) {
    out += chinese ? "最近 AI 交接：\n" : "Recent AI handoffs:\n";
    for (const line of handoffs) out += `${line}\n`;
  }
  out += chinese
    ? "做完一件事，照 .ai/INSTRUCTIONS.md 的「做完要寫回」在任務下面加一段 AI 工作紀錄。"
    : "When you finish a piece of work, add an AI work log under the task as \"Write back when you finish\" in .ai/INSTRUCTIONS.md describes.";
  return out;
}

function stop(input: Json, vault: string, session: string | null, stateDirectory: string, nowMs: number): HookOutcome {
  // A turn already continued by this hook, or Grok's extra Stop at shutdown.
  if (field(input, "stop_hook_active", "stopHookActive") === true) return { ...QUIET };
  const reason = field(input, "reason", "reason");
  if (reason === "shutdown" || reason === "channel_closed") return { ...QUIET };
  if (!session) return { ...QUIET };
  const statePath = path.join(stateDirectory, session);
  const stateText = readText(statePath);
  if (stateText === null) return { ...QUIET };
  const state = parseJson(stateText);
  if (!isObject(state) || state.reminded === true) return { ...QUIET };
  const started = state.startedMs;
  if (typeof started !== "number" || !Number.isInteger(started) || started < 0) return { ...QUIET };
  const baseline = isObject(state.counts) ? state.counts : {};
  let changed = false;
  for (const [relative, file] of markdownFiles(vault)) {
    let modified = 0;
    try {
      modified = Math.floor(fs.statSync(file).mtimeMs);
    } catch {
      // A file that vanished counts as untouched.
    }
    if (modified < started) continue;
    changed = true;
    const counted = baseline[relative];
    const before = typeof counted === "number" ? counted : 0;
    if (countWorklogs(readText(file) ?? "") > before) return { ...QUIET };
  }
  if (!changed) return { ...QUIET };
  try {
    fs.writeFileSync(statePath, JSON.stringify({ ...state, reminded: true, remindedMs: nowMs }));
  } catch {
    // Reminding again is better than not at all.
  }
  return {
    stdout: "",
    exitCode: 2,
    stderr: isChineseVault(vault)
      ? "這次有改到第二大腦的檔案，但還沒有寫 AI 工作紀錄。請照 .ai/INSTRUCTIONS.md 的「做完要寫回」，在對應任務下面加一段（做了什麼、結果在哪、下一步）；找不到任務就寫到 .ai/worklog/。已經不需要就簡短說明原因。"
      : "You changed files in this second brain but wrote no AI work log yet. Follow \"Write back when you finish\" in .ai/INSTRUCTIONS.md and add one under the matching task (done, result, next), or in .ai/worklog/ when no task matches. If none is needed, say why in one line.",
  };
}

function pruneOldStates(directory: string, nowMs: number): void {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      const file = path.join(directory, name);
      if (nowMs - fs.statSync(file).mtimeMs > STATE_MAX_AGE_MS) fs.rmSync(file);
    } catch {
      // Left for the next session.
    }
  }
}

/** Count `### AI 工作紀錄 …` / `### AI work log …` headings. */
export function countWorklogs(text: string): number {
  return text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trimStart();
    const hashes = /^#*/.exec(trimmed)![0].length;
    if (hashes < 2 || hashes > 4) return false;
    const rest = trimmed.slice(hashes).trimStart();
    return rest.startsWith("AI 工作紀錄") || rest.toLowerCase().startsWith("ai work log");
  }).length;
}

/**
 * Vault Markdown that a work log can land in: content files and `.ai/worklog/`.
 * Skips other hidden or technical folders, and everything else under `.ai/`
 * (`INDEX.md`, the `bin/` script, backups).
 */
function markdownFiles(vault: string): [string, string][] {
  const out: [string, string][] = [];
  const stack: [string, number][] = [[vault, 0]];
  while (stack.length > 0) {
    const [directory, depth] = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return out;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(directory, entry.name);
      const relative = path.relative(vault, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        const allowed = relative === ".ai" || relative === WORKLOG_DIR || relative.startsWith(`${WORKLOG_DIR}/`);
        const content = !relative.startsWith(".ai/") && !entry.name.startsWith(".") && entry.name !== "node_modules";
        if (depth < MAX_DEPTH && (allowed || content)) stack.push([full, depth + 1]);
      } else if (
        entry.isFile()
        && entry.name.toLowerCase().endsWith(".md")
        && (!relative.startsWith(".ai/") || relative.startsWith(`${WORKLOG_DIR}/`))
      ) {
        out.push([relative, full]);
      }
    }
  }
  return out;
}

async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of process.stdin) {
      const buffer = chunk as Buffer;
      chunks.push(buffer);
      total += buffer.length;
      if (total >= MAX_INPUT_BYTES) break;
    }
  } catch {
    // A closed stdin reads as no input, which passes.
  }
  return Buffer.concat(chunks).subarray(0, MAX_INPUT_BYTES).toString("utf8");
}

/** Handle `--aizbrain-hook session-start|stop [--format antigravity]`. `args` starts after the flag. */
export async function runHookEvent(args: readonly string[]): Promise<HookOutcome> {
  const command = args[0];
  if (command !== "session-start" && command !== "stop") {
    return { stdout: "", stderr: `usage: ${HOOK_FLAG} session-start|stop`, exitCode: 1 };
  }
  const antigravity = args.slice(1).some((value, index, rest) => value === "--format" && rest[index + 1] === "antigravity");
  try {
    const input = await readInput();
    const directory = stateDir();
    if (!directory) return { ...QUIET };
    const now = Date.now();
    return antigravity ? runAntigravityHook(command, input, directory, now) : runHook(command, input, directory, now);
  } catch {
    return antigravity ? { ...QUIET, stdout: "{}" } : { ...QUIET };
  }
}

export function emitOutcome(outcome: HookOutcome): void {
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  process.exitCode = outcome.exitCode;
}
