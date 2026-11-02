/**
 * The `aizbrain` command. Output stays plain and friendly: it follows the vault's
 * language where a vault is involved, and names no internals it can avoid.
 */
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { BrainTaskSnapshot, VaultLocale } from "@second-brain/brain-core";
import { emitOutcome, findVaultRoot, HOOK_FLAG, runHookEvent } from "./hook";
import {
  ALL_HOOK_TOOLS,
  HOOK_SCRIPT_PATH,
  HookConfigError,
  installHook,
  parseHookTool,
  readHookStatus,
  uninstallHook,
  VAULT_HOOK_TOOLS,
  type HookStatus,
  type HookTool,
} from "./hook-config";
import { initVault, isHomeFolder, type InitResult } from "./init";
import { runMcpServer } from "./mcp";
import { todayView } from "./tasks";
import { validateVaultRoot, VaultError } from "./vault-fs";
import { loadVault, refreshIndex, systemLocale, vaultLocale, VAULT_INDEX_PATH } from "./vault-read";

declare const __AIZBRAIN_VERSION__: string;
const VERSION = typeof __AIZBRAIN_VERSION__ === "string" ? __AIZBRAIN_VERSION__ : "0.0.0-dev";

const HELP = `aizbrain ${VERSION}
One shared, local Markdown memory for Claude Code, Codex, Gemini CLI and Antigravity.

Usage: aizbrain <command>

  init [folder]              Set up this folder (about 30 seconds, nothing to install)
    --locale en|zh-TW          Language of the folder names and instructions
    --tools a,b                Which AI tools to connect
                               Default: claude,gemini,antigravity. Add codex to include it.
    --no-hooks                 Do not connect any AI tool
    --dry-run                  Show what would happen and change nothing
    --yes                      Do not ask before using a folder that already has files

  today [folder]             Today's most important task, tasks and recent AI handoffs
  index [folder]             Rebuild .ai/INDEX.md
  doctor [folder]            Check what is set up, tool by tool
  hook install <tool> [folder]    Connect an AI tool
  hook uninstall <tool> [folder]  Disconnect an AI tool
                               Tools: claude (also Grok Build), gemini, antigravity, codex
  mcp [--vault folder]       Run the MCP server, for apps such as Claude Desktop

  --help, -h                 Show this help
  --version, -v              Show the version
`;

const TOOL_NAMES: Record<HookTool, { en: string; zh: string }> = {
  claude: { en: "Claude Code and Grok Build", zh: "Claude Code 與 Grok Build" },
  gemini: { en: "Gemini CLI", zh: "Gemini CLI" },
  antigravity: { en: "Antigravity", zh: "Antigravity" },
  codex: { en: "Codex", zh: "Codex" },
};

function say(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

function pick(locale: VaultLocale, en: string, zh: string): string {
  return locale === "en" ? en : zh;
}

function toolName(tool: HookTool, locale: VaultLocale): string {
  return locale === "en" ? TOOL_NAMES[tool].en : TOOL_NAMES[tool].zh;
}

function hookScriptSource(): string {
  return fileURLToPath(new URL("./aizbrain-hook.mjs", import.meta.url));
}

function parseTools(value: string): HookTool[] | string {
  const tools: HookTool[] = [];
  for (const name of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const tool = parseHookTool(name);
    if (!tool) return name;
    if (!tools.includes(tool)) tools.push(tool);
  }
  return tools;
}

/** Trust steps the user has to do once, in the tool itself. */
function trustHint(tool: HookTool, locale: VaultLocale): string | null {
  switch (tool) {
    case "claude": return pick(locale, "Grok Build only: trust the folder once with /hooks-trust.", "只有 Grok Build 要做：第一次在資料夾裡輸入 /hooks-trust。");
    case "gemini": return pick(locale, "Gemini CLI: trust this folder when it asks.", "Gemini CLI：出現詢問時請信任這個資料夾。");
    case "codex": return pick(locale, "Codex: type /hooks once, then review and trust the two new hooks.", "Codex：輸入一次 /hooks，檢查並信任這兩個新的 hook。");
    default: return null;
  }
}

function printInitResult(result: InitResult, codexListed: boolean, hooks: boolean): void {
  const { locale } = result;
  const dry = result.dryRun;
  say(dry
    ? pick(locale, `This is what aizbrain would do in ${result.root} (nothing was changed):`, `aizbrain 會在 ${result.root} 做這些事（這次沒有改動任何檔案）：`)
    : pick(locale, `aizbrain is ready in ${result.root}`, `aizbrain 已在 ${result.root} 準備好了`));
  say();
  if (result.created.length) {
    say(dry ? pick(locale, "Would add:", "會新增：") : pick(locale, "Added:", "新增了："));
    for (const file of result.created) say(`  ${file}`);
  }
  if (result.kept.length) say(pick(locale, `Kept as they are: ${result.kept.join(", ")}`, `原本就有，沒有更動：${result.kept.join("、")}`));
  if (result.appended) {
    say(dry
      ? pick(locale, "Would add the write-back rules to the end of .ai/INSTRUCTIONS.md", "會在 .ai/INSTRUCTIONS.md 檔尾補上寫回規則")
      : pick(locale, "Added the write-back rules to the end of .ai/INSTRUCTIONS.md (a backup is in .ai/backups)", "已在 .ai/INSTRUCTIONS.md 檔尾補上寫回規則（備份在 .ai/backups）"));
  }
  if (result.index === "foreign") say(pick(locale, ".ai/INDEX.md was not made by aizbrain, so it was left alone.", ".ai/INDEX.md 不是 aizbrain 產生的，所以沒有更動。"));
  else if (result.index === "created" && !dry) say(pick(locale, "Built .ai/INDEX.md", "已建立 .ai/INDEX.md"));
  else if (result.index === "created" || result.index === "updated") say(pick(locale, "Would build .ai/INDEX.md", "會建立 .ai/INDEX.md"));
  if (result.keptEntryFiles.length) {
    say(pick(
      locale,
      `Tip: you already have ${result.keptEntryFiles.join(", ")}. Add a line telling the AI to read .ai/INSTRUCTIONS.md.`,
      `提醒：你已經有 ${result.keptEntryFiles.join("、")}。可以加一行請 AI 先讀 .ai/INSTRUCTIONS.md。`,
    ));
  }

  const connected = result.tools.filter((item) => item.ok);
  const failed = result.tools.filter((item) => !item.ok);
  say();
  if (connected.length) {
    say(`${dry ? pick(locale, "Would connect:", "會連接：") : pick(locale, "Connected:", "已連接：")} ${connected.map((item) => toolName(item.tool, locale)).join(pick(locale, ", ", "、"))}`);
    for (const item of connected) {
      const hint = trustHint(item.tool, locale);
      if (hint) say(`  ${hint}`);
      if (item.tool === "codex") {
        say(`  ${pick(locale, `Codex keeps its settings per user, so this changed ${item.file}. It only acts inside a vault.`, `Codex 的設定是每個使用者一份，所以這次改了 ${item.file}。它只會在 vault 裡動作。`)}`);
      }
    }
  }
  for (const item of failed) say(pick(locale, `Could not connect ${toolName(item.tool, locale)}: ${item.message}`, `無法連接 ${toolName(item.tool, locale)}：${item.message}`));
  if (hooks && !codexListed) {
    say(pick(locale, "Codex was not touched: its settings are per user, not per folder. To connect it: npx aizbrain hook install codex", "沒有動 Codex：它的設定是每個使用者一份，不是每個資料夾一份。要連接的話：npx aizbrain hook install codex"));
  }
  if (!hooks) say(pick(locale, "No AI tool was connected. To connect one later: npx aizbrain hook install <tool>", "沒有連接任何 AI 工具。之後要連接：npx aizbrain hook install <tool>"));
  if (dry) return;
  say();
  say(pick(locale, "Next:", "下一步："));
  say(pick(locale, "  1. Open this folder in your AI tool.", "  1. 用你的 AI 工具打開這個資料夾。"));
  say(pick(locale, "  2. Ask it: \"What should I work on today?\"", "  2. 問它：「今天該做什麼？」"));
  say(pick(locale, "  3. Switch tools any time. The next AI picks up where the last one stopped.", "  3. 隨時可以換工具，下一個 AI 會接著上一個的進度。"));
}

async function confirm(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(question)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    prompt.close();
  }
}

function folderHasFiles(folder: string): boolean {
  try {
    return fs.readdirSync(folder).length > 0;
  } catch {
    return false;
  }
}

async function commandInit(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      locale: { type: "string" },
      tools: { type: "string" },
      "no-hooks": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
  });
  if (positionals.length > 1) return fail("init takes one folder. See: aizbrain --help");
  const locale = values.locale;
  if (locale !== undefined && locale !== "en" && locale !== "zh-TW") return fail(`Unknown language "${locale}". Use en or zh-TW.`);
  const parsed = values.tools === undefined ? [...VAULT_HOOK_TOOLS] : parseTools(values.tools);
  if (typeof parsed === "string") return fail(`Unknown tool "${parsed}". Use claude, gemini, antigravity or codex.`);
  const folder = path.resolve(positionals[0] ?? ".");
  const language = (locale as VaultLocale | undefined) ?? systemLocale();
  if (isHomeFolder(folder) && !values.yes) {
    return fail(pick(
      language,
      "This is your home folder, and connecting tools here would change your settings for every project.\nPick a folder for your vault, such as: npx aizbrain init my-brain\nTo use this folder anyway, add --yes.",
      "這是你的家目錄，在這裡連接工具會改到你所有專案的設定。\n請選一個資料夾，例如：npx aizbrain init my-brain\n確定要用這個資料夾，請加上 --yes。",
    ));
  }
  const isVault = fs.existsSync(path.join(folder, ".ai", "INSTRUCTIONS.md"));
  if (!values.yes && !values["dry-run"] && !isVault && process.stdin.isTTY && folderHasFiles(folder)) {
    const proceed = await confirm(pick(language, `${folder} already has files. aizbrain only adds its own and changes none of yours. Continue? [Y/n] `, `${folder} 裡已經有檔案。aizbrain 只會新增自己的檔案，不會改你的檔案。要繼續嗎？[Y/n] `));
    if (!proceed) return 0;
  }
  const result = initVault({
    folder,
    locale: locale as VaultLocale | undefined,
    tools: parsed,
    hooks: !values["no-hooks"],
    dryRun: values["dry-run"],
    hookScriptSource: hookScriptSource(),
  });
  printInitResult(result, parsed.includes("codex"), !values["no-hooks"]);
  return 0;
}

/** The vault at `folder`, or at or above the current folder when none is named. */
function vaultFolder(folder: string | undefined): string | null {
  return findVaultRoot(path.resolve(folder ?? "."));
}

const NO_VAULT = "No aizbrain vault here yet. To set one up: npx aizbrain init";

function taskLine(task: BrainTaskSnapshot): string {
  const time = task.startTime ? `${task.startTime} ` : "";
  const project = task.projectName ? ` [${task.projectName}]` : "";
  return `  ${time}${task.title}${project}`;
}

function commandToday(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const folder = vaultFolder(positionals[0]);
  if (!folder) return fail(NO_VAULT);
  const state = loadVault(folder);
  const { locale } = state;
  const view = todayView(state);
  say(pick(locale, `Today, ${view.today}`, `今天 ${view.today}`));
  say();
  const p1 = view.mostImportant;
  const p1Done = p1?.status === "done" ? pick(locale, " (done)", "（已完成）") : "";
  say(p1 ? pick(locale, `Most important: ${p1.title}${p1Done}`, `最重要：${p1.title}${p1Done}`) : pick(locale, "Most important: not chosen yet", "最重要：尚未選定"));
  say();
  if (view.todayTasks.length) {
    say(pick(locale, "Today's tasks:", "今天的任務："));
    for (const task of view.todayTasks) say(taskLine(task));
  } else {
    say(pick(locale, "Nothing scheduled for today.", "今天沒有排任務。"));
  }
  if (view.overdue.length) {
    say();
    say(pick(locale, "Overdue:", "逾期："));
    for (const task of view.overdue) say(`${taskLine(task)} (${task.taskDate})`);
  }
  say();
  if (view.handoffs.length) {
    say(pick(locale, "Recent AI handoffs:", "最近的 AI 交接："));
    for (const item of view.handoffs) {
      const next = item.next ? pick(locale, `, next: ${item.next}`, `，下一步：${item.next}`) : "";
      say(`  ${item.date} ${item.time} ${item.tool}: ${item.taskTitle}${next}`);
    }
  } else {
    say(pick(locale, "No AI handoffs yet.", "還沒有 AI 交接。"));
  }
  return 0;
}

function commandIndex(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const folder = vaultFolder(positionals[0]);
  if (!folder) return fail(NO_VAULT);
  const locale = vaultLocale(folder, systemLocale());
  const outcome = refreshIndex(folder);
  if (outcome === "foreign") return fail(pick(locale, `${VAULT_INDEX_PATH} was not made by aizbrain, so it was left alone.`, `${VAULT_INDEX_PATH} 不是 aizbrain 產生的，所以沒有更動。`));
  say(outcome === "unchanged"
    ? pick(locale, `${VAULT_INDEX_PATH} is already up to date.`, `${VAULT_INDEX_PATH} 已經是最新的。`)
    : pick(locale, `${VAULT_INDEX_PATH} is rebuilt.`, `${VAULT_INDEX_PATH} 已重新產生。`));
  return 0;
}

function doctorLine(status: HookStatus, locale: VaultLocale, folder: string): string {
  const name = toolName(status.tool, locale);
  const viaApp = status.program && !status.program.endsWith("aizbrain-hook.mjs");
  const viaOtherVault = status.program && !viaApp && !path.resolve(status.program).startsWith(path.resolve(folder));
  switch (status.state) {
    case "connected":
      if (viaApp) return pick(locale, `${name}: connected, through the aizbrain desktop app.`, `${name}：已連接，透過 aizbrain 桌面版。`);
      if (viaOtherVault) return pick(locale, `${name}: connected, using the helper in ${status.program}. It still works in this vault.`, `${name}：已連接，使用 ${status.program} 的小幫手，在這個 vault 也有效。`);
      return pick(locale, `${name}: connected.`, `${name}：已連接。`);
    case "off":
      return pick(locale, `${name}: set up, but hooks are turned off in ${status.file} (hooksConfig.enabled).`, `${name}：已設定，但 ${status.file} 把 hook 關掉了（hooksConfig.enabled）。`);
    case "broken":
      return pick(locale, `${name}: set up, but ${status.program} is missing. Fix it with: npx aizbrain hook install ${status.tool}`, `${name}：已設定，但找不到 ${status.program}。修復方式：npx aizbrain hook install ${status.tool}`);
    case "invalid":
      return pick(locale, `${name}: ${status.file} is not valid JSON, so it can't be read. Fix that file first.`, `${name}：${status.file} 不是合法的 JSON，無法讀取，請先修好這個檔案。`);
    case "missing":
      return pick(locale, `${name}: not connected. To connect: npx aizbrain hook install ${status.tool}`, `${name}：尚未連接。要連接：npx aizbrain hook install ${status.tool}`);
  }
}

function commandDoctor(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const folder = vaultFolder(positionals[0]);
  if (!folder) {
    say(NO_VAULT);
    return 1;
  }
  const locale = vaultLocale(folder, systemLocale());
  say(pick(locale, `Vault: ${folder}`, `Vault：${folder}`));
  say(pick(locale, `Node.js ${process.version}, aizbrain ${VERSION}`, `Node.js ${process.version}，aizbrain ${VERSION}`));
  say();
  try {
    validateVaultRoot(folder);
    const state = loadVault(folder);
    say(pick(locale, `Your folder: ${state.files.size} Markdown files, ${state.tasks.length} tasks, ${state.projects.length} projects.`, `你的資料夾：${state.files.size} 個 Markdown 檔、${state.tasks.length} 個任務、${state.projects.length} 個專案。`));
    if (state.skipped.length) say(pick(locale, `Skipped (links, very large or not UTF-8): ${state.skipped.join(", ")}`, `略過（連結、太大或不是 UTF-8）：${state.skipped.join("、")}`));
  } catch (error) {
    say(pick(locale, `Could not read this folder: ${(error as Error).message}`, `無法讀取這個資料夾：${(error as Error).message}`));
  }
  const hasIndex = fs.existsSync(path.join(folder, ".ai", "INDEX.md"));
  say(hasIndex ? pick(locale, "Index: .ai/INDEX.md is there.", "索引：有 .ai/INDEX.md。") : pick(locale, "Index: missing. Build it with: npx aizbrain index", "索引：沒有。建立方式：npx aizbrain index"));
  const hasScript = fs.existsSync(path.join(folder, ...HOOK_SCRIPT_PATH.split("/")));
  say(hasScript ? pick(locale, `Helper: ${HOOK_SCRIPT_PATH} is there.`, `小幫手：有 ${HOOK_SCRIPT_PATH}。`) : pick(locale, "Helper: not installed (it comes with the first connected tool).", "小幫手：還沒安裝（連接第一個工具時會裝好）。"));
  say();
  for (const tool of ALL_HOOK_TOOLS) say(doctorLine(readHookStatus(tool, folder), locale, folder));
  return 0;
}

function commandHook(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const [action, toolArg, folderArg] = positionals;
  if ((action !== "install" && action !== "uninstall") || !toolArg) {
    return fail("Usage: aizbrain hook install|uninstall <tool> [folder]\nTools: claude, gemini, antigravity, codex");
  }
  const tool = parseHookTool(toolArg);
  if (!tool) return fail(`Unknown tool "${toolArg}". Use claude, gemini, antigravity or codex.`);
  return applyHook(action === "install", tool, path.resolve(folderArg ?? "."));
}

function applyHook(install: boolean, tool: HookTool, folder: string): number {
  if (findVaultRoot(folder) !== folder) return fail(`${folder} has no aizbrain .ai/INSTRUCTIONS.md. Set it up first: npx aizbrain init`);
  const locale = vaultLocale(folder, systemLocale());
  const root = validateVaultRoot(folder);
  const name = toolName(tool, locale);
  try {
    const file = install ? installHook(tool, root, hookScriptSource()) : uninstallHook(tool, root);
    say(install
      ? pick(locale, `${name} is connected. Changed ${file}`, `${name} 已連接。改了 ${file}`)
      : pick(locale, `${name} is disconnected. Changed ${file}`, `${name} 已中斷連接。改了 ${file}`));
    if (install) {
      const hint = trustHint(tool, locale);
      if (hint) say(hint);
    }
    return 0;
  } catch (error) {
    if (error instanceof HookConfigError) return fail(error.message);
    throw error;
  }
}

async function commandMcp(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { vault: { type: "string" } } });
  await runMcpServer(values.vault === undefined ? undefined : path.resolve(values.vault), VERSION);
  return 0;
}

/** `--aizbrain-hook` at the top level: the event form tools run, and the app's install form. */
async function commandHookFlag(args: string[]): Promise<number> {
  if (args[0] === "install" || args[0] === "uninstall") {
    const tool = parseHookTool(args[1] ?? "");
    if (!tool || !args[2]) return fail(`usage: ${HOOK_FLAG} install|uninstall claude|codex|gemini|antigravity <vault folder>`);
    return applyHook(args[0] === "install", tool, path.resolve(args[2]));
  }
  emitOutcome(await runHookEvent(args));
  return process.exitCode === undefined ? 0 : Number(process.exitCode);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined: case "--help": case "-h": case "help":
      process.stdout.write(HELP);
      return 0;
    case "--version": case "-v":
      say(VERSION);
      return 0;
    case HOOK_FLAG: return commandHookFlag(rest);
    case "init": return commandInit(rest);
    case "today": return commandToday(rest);
    case "index": return commandIndex(rest);
    case "doctor": return commandDoctor(rest);
    case "hook": return commandHook(rest);
    case "mcp": return commandMcp(rest);
    default:
      return fail(`Unknown command "${command}". See: aizbrain --help`);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (process.argv[2] === HOOK_FLAG) {
    process.exitCode = 0;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
