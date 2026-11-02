/**
 * Reads a vault the way the desktop app does, without changing it.
 *
 * The desktop's first scan of a task without an id writes a new id into the file
 * and only sees the task's notes on the next scan. The CLI never writes while
 * reading, so it gives such tasks an id in memory first. The id is derived from
 * the file and the line, so a later `complete_task` finds the same task.
 */
import fs from "node:fs";
import path from "node:path";
import {
  createCodeFenceTracker,
  endIndexOfTaskBody,
  parseTaskLine,
  patchTaskLineMinimal,
  rankForIndex,
  setActiveVaultLayout,
  vaultLayoutFor,
  type BrainCollectionSnapshot,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
  type VaultIndexInput,
  type VaultLayout,
  type VaultLocale,
} from "@second-brain/brain-core";
import { renderIndexChange, VAULT_INDEX_PATH, VAULT_INSTRUCTIONS_PATH } from "../../../apps/desktop/src/architecture";
import { scanStructuredVault, type LocalMarkdownFile } from "../../../apps/desktop/src/vault";
import { atomicCreate, atomicReplace, decodeUtf8, resolveMarkdownPath, scanMarkdown, sha256Hex, validateVaultRoot, type MarkdownFile } from "./vault-fs";

/** The first line of an index aizbrain generated (app or CLI). Anything else is the user's. */
const OWN_INDEX_HEADING = "# Second Brain — Vault Index";
const LEGACY_CONTENT_START = /^\s*<!-- second-brain-task-content:[0-9a-f-]{36}:start -->\s*$/i;
const LEGACY_CONTENT_END = /^\s*<!-- second-brain-task-content:[0-9a-f-]{36}:end -->\s*$/i;

export function localDateKey(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function localTimeKey(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** `zh-TW`, `zh-Hant`, `zh-HK` and `zh-MO` get the Traditional Chinese layout; all else English. */
export function localeFromTag(tag: string | undefined): VaultLocale {
  return /^zh[-_](tw|hk|mo|hant)/i.test(tag ?? "") ? "zh-TW" : "en";
}

export function systemLocale(): VaultLocale {
  return localeFromTag(Intl.DateTimeFormat().resolvedOptions().locale);
}

export function isChineseInstructions(text: string): boolean {
  return text.includes("做完要寫回") || text.includes("讀取順序");
}

export function readInstructions(root: string): string | null {
  try {
    return decodeUtf8(fs.readFileSync(path.join(root, ".ai", "INSTRUCTIONS.md")));
  } catch {
    return null;
  }
}

/**
 * The language of an existing vault. An inbox folder decides, since that is where
 * tasks go; otherwise the language of `.ai/INSTRUCTIONS.md`. The desktop's wider
 * folder check is not used: a code project with `templates/` is not a language choice.
 */
export function vaultLocale(root: string, fallback: VaultLocale): VaultLocale {
  const hasDir = (name: string) => fs.existsSync(path.join(root, name));
  if (hasDir("收件匣") || hasDir("10-收件匣")) return "zh-TW";
  if (hasDir("Inbox")) return "en";
  const instructions = readInstructions(root);
  if (instructions === null) return fallback;
  return isChineseInstructions(instructions) ? "zh-TW" : "en";
}

export interface TaskLocation {
  relativePath: string;
  lineIndex: number;
}

export interface VaultState {
  root: string;
  locale: VaultLocale;
  layout: VaultLayout;
  files: Map<string, MarkdownFile>;
  /** Every task has an id; see the note at the top of this file. */
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  collections: BrainCollectionSnapshot[];
  locations: Map<string, TaskLocation>;
  skipped: string[];
  today: string;
}

function derivedId(seed: string): string {
  const hex = sha256Hex(Buffer.from(seed, "utf8"));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Fill in missing or repeated task ids, in memory only, keeping every line in its place. */
function adoptTasksInMemory(files: readonly MarkdownFile[]): { sources: Map<string, string>; locations: Map<string, TaskLocation> } {
  const sources = new Map<string, string>();
  const locations = new Map<string, TaskLocation>();
  const seen = new Set<string>();
  let count = 0;
  for (const file of files) {
    const newline = file.text.includes("\r\n") ? "\r\n" : "\n";
    const lines = file.text.split(/\r?\n/);
    const inCodeFence = createCodeFenceTracker();
    const occurrences = new Map<string, number>();
    let insideLegacyContent = false;
    let skipUntil = 0;
    let changed = false;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (inCodeFence(line)) continue;
      if (LEGACY_CONTENT_START.test(line)) { insideLegacyContent = true; continue; }
      if (LEGACY_CONTENT_END.test(line)) { insideLegacyContent = false; continue; }
      if (insideLegacyContent || index < skipUntil) continue;
      const parsed = parseTaskLine(line, file.relativePath, index);
      if (!parsed) continue;
      skipUntil = endIndexOfTaskBody(lines, index);
      let id = parsed.id;
      if (!id || seen.has(id)) {
        const key = line.replace(/^\uFEFF/, "").trimEnd();
        const occurrence = occurrences.get(key) ?? 0;
        occurrences.set(key, occurrence + 1);
        id = derivedId(`${file.relativePath}\0${key}\0${occurrence}`);
        const { lineIndex: _lineIndex, rawLine: _rawLine, markerIssue: _markerIssue, ...task } = parsed;
        lines[index] = patchTaskLineMinimal(line, { ...task, id, rank: parsed.rank || rankForIndex(count), schemaVersion: 6 });
        changed = true;
      }
      seen.add(id);
      locations.set(id, { relativePath: file.relativePath, lineIndex: index });
      count += 1;
    }
    sources.set(file.relativePath, changed ? lines.join(newline) : file.text);
  }
  return { sources, locations };
}

/** Load the vault, or throw a `VaultError`. Writes nothing. */
export function loadVault(rootInput: string, now: Date = new Date(), fallback: VaultLocale = "en"): VaultState {
  const root = validateVaultRoot(rootInput);
  const locale = vaultLocale(root, fallback);
  const layout = vaultLayoutFor(locale);
  // Scan rules and write paths read the active layout.
  setActiveVaultLayout(layout);
  const { files, skipped } = scanMarkdown(root);
  const { sources, locations } = adoptTasksInMemory(files);
  const scanInput: LocalMarkdownFile[] = files.map((file) => ({
    relativePath: file.relativePath,
    sha256: file.sha256,
    bytesBase64: Buffer.from(sources.get(file.relativePath)!, "utf8").toString("base64"),
  }));
  // Reading again must give the same ids for projects that have none in the file.
  let minted = 0;
  const { snapshot } = scanStructuredVault(scanInput, () => derivedId(`entity\0${minted++}`));
  return {
    root,
    locale,
    layout,
    files: new Map(files.map((file) => [file.relativePath, file])),
    tasks: snapshot.tasks,
    projects: snapshot.projects,
    collections: snapshot.collections,
    locations,
    skipped,
    today: localDateKey(now),
  };
}

export function isOwnIndex(text: string): boolean {
  return text.replace(/^\uFEFF/, "").startsWith(OWN_INDEX_HEADING);
}

export type IndexRefresh = "created" | "updated" | "unchanged" | "foreign";

/**
 * Regenerate `.ai/INDEX.md` when its content differs, ignoring the time stamp.
 * The file is machine-made, so it gets an atomic write and no backup, the same
 * way nothing else in the vault is touched. An index aizbrain did not generate
 * is left alone.
 */
export function refreshIndex(rootInput: string, now: Date = new Date(), options: { dryRun?: boolean; fallback?: VaultLocale } = {}): IndexRefresh {
  const state = loadVault(rootInput, now, options.fallback);
  const target = options.dryRun
    ? path.join(state.root, ...VAULT_INDEX_PATH.split("/"))
    : resolveMarkdownPath(state.root, VAULT_INDEX_PATH, { create: true });
  const existingBytes = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const existingText = existingBytes ? decodeUtf8(existingBytes) : null;
  if (existingBytes && (existingText === null || !isOwnIndex(existingText))) return "foreign";
  const input: VaultIndexInput = {
    today: state.today,
    generatedAt: now.toISOString(),
    tasks: state.tasks,
    projects: state.projects,
    collections: state.collections,
    existingPaths: [...state.files.keys()],
  };
  const existing: LocalMarkdownFile | undefined = existingBytes
    ? { relativePath: VAULT_INDEX_PATH, sha256: sha256Hex(existingBytes), bytesBase64: existingBytes.toString("base64") }
    : undefined;
  const change = renderIndexChange(input, existing);
  if (!change || change.operation === "delete") return "unchanged";
  if (options.dryRun) return existingBytes ? "updated" : "created";
  const replacement = Buffer.from(change.replacementBase64, "base64");
  if (!existingBytes) {
    atomicCreate(target, replacement);
    return "created";
  }
  // The app may have refreshed it while this scan ran; its copy is as good as ours.
  if (sha256Hex(fs.readFileSync(target)) !== sha256Hex(existingBytes)) return "unchanged";
  atomicReplace(target, replacement);
  return "updated";
}

export { VAULT_INDEX_PATH, VAULT_INSTRUCTIONS_PATH };
