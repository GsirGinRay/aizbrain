/**
 * `aizbrain init`: scaffold the AI-handoff pack, build the index and connect AI
 * tools. It only adds: existing files are kept, except that an INSTRUCTIONS.md
 * without the write-back rules gets them appended once, as the desktop does.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AI_ENTRY_FILES,
  LEGACY_INBOX_PATH,
  scaffoldTemplateFiles,
  setActiveVaultLayout,
  vaultLayoutFor,
  type VaultLocale,
} from "@second-brain/brain-core";
import { writeBackUpgradeChange } from "../../../apps/desktop/src/architecture";
import { findVaultRoot } from "./hook";
import { HookConfigError, hookConfigPath, installHook, type HookTool } from "./hook-config";
import { atomicCreate, commitMarkdown, resolveMarkdownPath, resolveOwnFilePath, sha256Hex, validateVaultRoot, VaultError } from "./vault-fs";
import { localDateKey, readInstructions, refreshIndex, systemLocale, VAULT_INDEX_PATH, VAULT_INSTRUCTIONS_PATH, vaultLocale, type IndexRefresh } from "./vault-read";

/** Backups and the generated script should not end up in the user's git history. */
const AI_GITIGNORE = ".ai/.gitignore";
const AI_GITIGNORE_CONTENT = "backups/\nbin/\n";

/** A new inbox starts with one task for today, so the first question to an AI has an answer. */
function firstTask(locale: VaultLocale, now: Date): string {
  const title = locale === "zh-TW"
    ? "試試 AI 交接：請這家 AI 做一件小事，再換一家問它做到哪了"
    : "Try the handoff: have this AI do something small, then ask another AI where it left off";
  return `- [ ] #task ${title} \u{1F53A} \u{23F3} ${localDateKey(now)}\n`;
}

export interface InitOptions {
  folder: string;
  locale?: VaultLocale;
  tools: readonly HookTool[];
  hooks: boolean;
  dryRun: boolean;
  /** Absolute path of the bundled hook script. */
  hookScriptSource: string;
}

export interface ToolResult {
  tool: HookTool;
  file: string;
  ok: boolean;
  message?: string;
}

export interface InitResult {
  root: string;
  locale: VaultLocale;
  created: string[];
  kept: string[];
  /** INSTRUCTIONS.md got the write-back rules appended. */
  appended: boolean;
  /** Our entry files that were not created because the user already has one. */
  keptEntryFiles: string[];
  index: IndexRefresh;
  tools: ToolResult[];
  dryRun: boolean;
}

export function isHomeFolder(folder: string): boolean {
  const resolve = (value: string) => {
    try {
      return fs.realpathSync.native(value).toLowerCase();
    } catch {
      return path.resolve(value).toLowerCase();
    }
  };
  return resolve(folder) === resolve(os.homedir());
}

/**
 * An aizbrain vault keeps its language. Otherwise the flag decides, then the
 * language of rules already in the folder, then its inbox folder, then the system.
 */
function chooseLocale(root: string, requested: VaultLocale | undefined): VaultLocale {
  if (findVaultRoot(root) === root) return vaultLocale(root, requested ?? systemLocale());
  if (requested) return requested;
  const instructions = readInstructions(root);
  if (instructions !== null && /\p{Script=Han}/u.test(instructions)) return "zh-TW";
  return vaultLocale(root, systemLocale());
}

function previewTool(tool: HookTool, root: string): ToolResult {
  const file = hookConfigPath(tool, root);
  try {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF+/, "");
      if (text.trim()) JSON.parse(text);
    }
    return { tool, file, ok: true };
  } catch {
    return { tool, file, ok: false, message: `${file} is not valid JSON; left unchanged` };
  }
}

export function initVault(options: InitOptions): InitResult {
  const target = path.resolve(options.folder);
  if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) throw new VaultError("INVALID", `${target} is a file, not a folder.`);
  if (!options.dryRun) fs.mkdirSync(target, { recursive: true });
  const exists = fs.existsSync(target);
  const root = exists ? validateVaultRoot(target) : target;
  const locale = exists ? chooseLocale(root, options.locale) : options.locale ?? systemLocale();
  setActiveVaultLayout(vaultLayoutFor(locale));

  const layout = vaultLayoutFor(locale);
  const inboxPath = `${layout.inboxDir}/${layout.inboxFile}`;
  const files = scaffoldTemplateFiles(["projects", "knowledge", "ai"], { locale });
  const created: string[] = [];
  const kept: string[] = [];
  const keptEntryFiles: string[] = [];
  const entryNames: readonly string[] = AI_ENTRY_FILES;
  for (const [relative, content] of Object.entries(files)) {
    // The index is generated below from what is in the folder.
    if (relative === VAULT_INDEX_PATH) continue;
    // A vault from before the current layout keeps writing to its own inbox.
    if (relative === inboxPath && exists && fs.existsSync(path.join(root, ...LEGACY_INBOX_PATH.split("/")))) continue;
    const present = exists && fs.existsSync(path.join(root, ...relative.split("/")));
    if (present) {
      kept.push(relative);
      if (entryNames.includes(relative)) keptEntryFiles.push(relative);
    } else if (options.dryRun) {
      created.push(relative);
    } else if (atomicCreate(
      resolveMarkdownPath(root, relative, { create: true }),
      Buffer.from(relative === inboxPath ? `${content.replace(/\s*$/, "")}\n\n${firstTask(locale, new Date())}` : content, "utf8"),
    )) {
      created.push(relative);
    } else {
      kept.push(relative);
    }
  }

  // Scaffolded just now, or already there: an older one gets the rules once.
  let appended = false;
  const instructionsPath = path.join(root, ...VAULT_INSTRUCTIONS_PATH.split("/"));
  if (exists && fs.existsSync(instructionsPath)) {
    const bytes = fs.readFileSync(instructionsPath);
    const change = writeBackUpgradeChange({
      relativePath: VAULT_INSTRUCTIONS_PATH,
      sha256: sha256Hex(bytes),
      bytesBase64: bytes.toString("base64"),
    });
    if (change && change.operation !== "delete") {
      appended = true;
      if (!options.dryRun) commitMarkdown(root, VAULT_INSTRUCTIONS_PATH, sha256Hex(bytes), Buffer.from(change.replacementBase64, "base64"));
    }
  }

  const index: IndexRefresh = exists ? refreshIndex(root, new Date(), { dryRun: options.dryRun, fallback: locale }) : "created";
  if (options.dryRun) {
    if (!exists || !fs.existsSync(path.join(root, ...AI_GITIGNORE.split("/")))) created.push(AI_GITIGNORE);
  } else if (atomicCreate(resolveOwnFilePath(root, AI_GITIGNORE, { create: true }), Buffer.from(AI_GITIGNORE_CONTENT, "utf8"))) {
    created.push(AI_GITIGNORE);
  }

  const tools: ToolResult[] = [];
  if (options.hooks) {
    for (const tool of options.tools) {
      if (options.dryRun) {
        tools.push(previewTool(tool, root));
        continue;
      }
      const file = hookConfigPath(tool, root);
      try {
        installHook(tool, root, options.hookScriptSource);
        tools.push({ tool, file, ok: true });
      } catch (error) {
        if (!(error instanceof HookConfigError || error instanceof VaultError)) throw error;
        tools.push({ tool, file, ok: false, message: error.message });
      }
    }
  }
  return { root, locale, created, kept, appended, keptEntryFiles, index, tools, dryRun: options.dryRun };
}
