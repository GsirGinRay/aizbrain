/**
 * File rules for the vault, mirroring the desktop app's Rust `path_policy.rs`,
 * `backup.rs` and `atomic_write.rs`: paths stay inside the canonical root, links
 * and hidden or technical folders are refused, and a Markdown file is only
 * replaced atomically, after a verified backup and a fresh hash check.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type VaultErrorCode = "UNSAFE_PATH" | "CONFLICT" | "LOCKED" | "LIMIT" | "BACKUP_FAILED" | "NOT_FOUND" | "INVALID";

export class VaultError extends Error {
  constructor(readonly code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
  }
}

const MAX_FILES = 100_000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 2_000;
const KEEP_BACKUPS = 50;
export const BACKUPS_DIR = ".ai/backups";

const TECHNICAL_NAMES = new Set([
  ".obsidian", ".git", ".trash", ".publisher-sync", "node_modules",
  "claude.md", "agents.md", "gemini.md", "qwen.md",
]);
const MANAGED_NAMES = new Set([".ai", "模板", "90-模板", "templates", "claude.md", "agents.md", "gemini.md", "qwen.md"]);
const TEMPLATE_DIRS = new Set(["模板", "90-模板", "Templates"]);

function isTechnicalName(name: string): boolean {
  return TECHNICAL_NAMES.has(name.toLowerCase()) || name.startsWith(".");
}

function isManagedName(name: string): boolean {
  return MANAGED_NAMES.has(name.toLowerCase());
}

function isScanSkippedDir(name: string): boolean {
  const lower = name.toLowerCase();
  return TEMPLATE_DIRS.has(name) || lower === "附件" || name === "Attachments" || lower === "tmp" || lower.includes("backup");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `attrib` is the one way to read the Hidden flag without a native module. */
function hasHiddenAttribute(target: string): boolean {
  const system = process.env.SystemRoot ?? "C:\\Windows";
  const result = spawnSync(path.join(system, "System32", "attrib.exe"), [target], { encoding: "latin1", windowsHide: true });
  if (result.status !== 0 || !result.stdout) return false;
  // "A  H        C:\path": the flags come before the path, which may itself contain an H.
  const flags = result.stdout.slice(0, Math.max(0, result.stdout.search(/[A-Za-z]:[\\/]|[\\/]{2}/)));
  return flags.includes("H");
}

function isHidden(target: string): boolean {
  if (process.platform === "win32") return hasHiddenAttribute(target);
  return path.basename(target).startsWith(".");
}

/**
 * Symlinks and junctions show up in `lstat`. The directory listing also marks
 * every other Windows reparse point, which `lstat` reports as an ordinary file.
 */
function isLinkOrReparsePoint(target: string, stat: fs.Stats): boolean {
  if (stat.isSymbolicLink()) return true;
  if (process.platform !== "win32") return false;
  const name = path.basename(target).toLowerCase();
  try {
    const entry = fs.readdirSync(path.dirname(target), { withFileTypes: true }).find((item) => item.name.toLowerCase() === name);
    return entry?.isSymbolicLink() ?? false;
  } catch {
    return false;
  }
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function unsafe(detail: string): VaultError {
  return new VaultError("UNSAFE_PATH", `Refused an unsafe path: ${detail}`);
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The folder the user chose, resolved. Refuses links, hidden and technical folders. */
export function validateVaultRoot(root: string): string {
  const absolute = path.resolve(root);
  const stat = lstatOrNull(absolute);
  if (!stat || !stat.isDirectory() || isLinkOrReparsePoint(absolute, stat) || isHidden(absolute)) throw unsafe(absolute);
  const canonical = fs.realpathSync.native(absolute);
  const name = path.basename(canonical);
  if (name && (isTechnicalName(name) || TEMPLATE_DIRS.has(name))) throw unsafe(canonical);
  return canonical;
}

/** A vault-relative Markdown path, with forward slashes. Same rules as `validate_relative_path`. */
export function validateRelativePath(relative: string): string[] {
  if (!relative || relative.includes("\0") || relative.includes("\\") || relative.includes(":") || path.isAbsolute(relative) || relative.startsWith("/")) {
    throw unsafe(relative);
  }
  const parts = relative.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") throw unsafe(relative);
    if (!isManagedName(part) && (isTechnicalName(part) || TEMPLATE_DIRS.has(part))) throw unsafe(relative);
  }
  if (path.posix.extname(relative) !== ".md") throw unsafe(relative);
  return parts;
}

/** Walk `parts` under the root one step at a time, refusing anything that could lead outside it. */
function walkInsideRoot(root: string, parts: readonly string[], create: boolean, ownFile = false): string {
  let current = root;
  parts.forEach((part, index) => {
    current = path.join(current, part);
    const last = index === parts.length - 1;
    let stat = lstatOrNull(current);
    if (!stat && !last && create) {
      fs.mkdirSync(current);
      stat = lstatOrNull(current);
    }
    if (!stat) {
      if (last) return;
      throw new VaultError("NOT_FOUND", `Missing folder: ${parts.slice(0, index + 1).join("/")}`);
    }
    if (isLinkOrReparsePoint(current, stat)) throw unsafe(parts.join("/"));
    const exempt = part.toLowerCase() === ".ai" || (ownFile && last);
    if (!exempt && isHidden(current)) throw unsafe(parts.join("/"));
    if (!last && !stat.isDirectory()) throw unsafe(parts.join("/"));
    if (last && stat.isDirectory()) throw unsafe(parts.join("/"));
  });
  const canonicalParent = fs.realpathSync.native(path.dirname(current));
  if (!isInside(root, canonicalParent)) throw unsafe(parts.join("/"));
  if (fs.existsSync(current) && !isInside(root, fs.realpathSync.native(current))) throw unsafe(parts.join("/"));
  return current;
}

/** Absolute path of an existing or new Markdown file inside the root. */
export function resolveMarkdownPath(root: string, relative: string, options: { create?: boolean } = {}): string {
  return walkInsideRoot(root, validateRelativePath(relative), options.create ?? false);
}

/** Same walk for the few non-Markdown files aizbrain owns under `.ai/`. */
export function resolveOwnFilePath(root: string, relative: string, options: { create?: boolean } = {}): string {
  if (!relative.startsWith(".ai/") || relative.includes("..") || relative.includes("\\")) throw unsafe(relative);
  return walkInsideRoot(root, relative.split("/"), options.create ?? false, true);
}

export interface MarkdownFile {
  relativePath: string;
  sha256: string;
  bytes: Buffer;
  /** Decoded text, with any BOM still in place. */
  text: string;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Text of a file, or null when it is not valid UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * All content Markdown in the vault, sorted by path. Unlike the desktop scan, a
 * link does not abort it: developers run this in project folders where links are
 * normal. Links are never followed, and writes through them are refused.
 */
export function scanMarkdown(root: string): { files: MarkdownFile[]; skipped: string[] } {
  const files: MarkdownFile[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (isTechnicalName(entry.name)) continue;
      const relativePath = path.relative(root, full).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        skipped.push(relativePath);
        continue;
      }
      if (entry.isDirectory()) {
        if (!isScanSkippedDir(entry.name)) stack.push(full);
        continue;
      }
      if (!entry.isFile() || path.extname(entry.name) !== ".md") continue;
      const size = fs.statSync(full).size;
      if (size > MAX_FILE_BYTES) {
        skipped.push(relativePath);
        continue;
      }
      totalBytes += size;
      if (totalBytes > MAX_TOTAL_BYTES || files.length >= MAX_FILES) {
        throw new VaultError("LIMIT", "This folder has too much Markdown to scan.");
      }
      const bytes = fs.readFileSync(full);
      const text = decodeUtf8(bytes);
      if (text === null) {
        skipped.push(relativePath);
        continue;
      }
      files.push({ relativePath, sha256: sha256Hex(bytes), bytes, text });
    }
  }
  files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
  return { files, skipped };
}

function writeTempFile(temp: string, bytes: Uint8Array, mode?: number): void {
  const handle = fs.openSync(temp, "wx", mode);
  try {
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function tempPathFor(target: string): string {
  return path.join(path.dirname(target), `.aizbrain-${randomUUID()}.tmp`);
}

/** Replace `target` in one step. An editor or virus scanner holding the file gets a few retries. */
export function atomicReplace(target: string, bytes: Uint8Array): void {
  const temp = tempPathFor(target);
  const stat = lstatOrNull(target);
  try {
    writeTempFile(temp, bytes, stat ? stat.mode & 0o777 : undefined);
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temp, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
        sleepSync(50 * (attempt + 1));
      }
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Create `target` atomically. Returns false, changing nothing, when it already exists. */
export function atomicCreate(target: string, bytes: Uint8Array): boolean {
  if (lstatOrNull(target)) return false;
  const temp = tempPathFor(target);
  try {
    writeTempFile(temp, bytes);
    try {
      // A hard link fails when the name is taken; rename would overwrite it.
      fs.linkSync(temp, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (lstatOrNull(target)) return false;
      fs.renameSync(temp, target);
    }
    return true;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Same lock file name as the desktop writer, so the two wait for each other. */
function withFileLock<T>(target: string, work: () => T): T {
  const lock = target.slice(0, target.length - path.extname(target).length) + ".publisher-sync.lock";
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatOrNull(lock);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new VaultError("LOCKED", "Another program is writing this file. Try again in a moment.");
      sleepSync(50);
    }
  }
  try {
    return work();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

function pruneBackups(root: string): void {
  try {
    const directory = path.join(root, ...BACKUPS_DIR.split("/"));
    const names = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}-[0-9a-f]{8}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) {
      fs.rmSync(path.join(directory, name), { recursive: true, force: true });
    }
  } catch {
    // Old backups staying around is harmless.
  }
}

/**
 * Copy one file to `.ai/backups/<time>-<id>/` with a manifest, then read the
 * copy back and compare its hash. A plain folder rather than the desktop's zip:
 * Node has no zip writer and the package has no dependencies.
 */
export function createVerifiedBackup(root: string, relative: string, bytes: Uint8Array): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const backupRelative = `${BACKUPS_DIR}/${stamp}-${randomUUID().slice(0, 8)}`;
  const manifestPath = resolveOwnFilePath(root, `${backupRelative}/manifest.json`, { create: true });
  const copyPath = path.join(path.dirname(manifestPath), ...relative.split("/"));
  try {
    fs.mkdirSync(path.dirname(copyPath), { recursive: true });
    writeTempFile(copyPath, bytes);
    const sha256 = sha256Hex(bytes);
    writeTempFile(manifestPath, Buffer.from(JSON.stringify({
      version: 1,
      created_at_unix_ms: Date.now(),
      entries: [{ relative_path: relative, sha256, bytes: bytes.length }],
    }, null, 2)));
    if (sha256Hex(fs.readFileSync(copyPath)) !== sha256) throw new Error("hash mismatch");
  } catch (cause) {
    throw new VaultError("BACKUP_FAILED", `Could not back up ${relative}, so nothing was changed. (${(cause as Error).message})`);
  }
  pruneBackups(root);
  return backupRelative;
}

export interface CommitOptions {
  /** Test seam: runs after the backup, before the last hash check. */
  beforeReplace?: () => void;
}

export interface CommitResult {
  sha256: string;
  /** Vault-relative backup folder; null for a brand-new file. */
  backup: string | null;
}

/**
 * Write one Markdown file. `expectedSha256` is the hash the edit was based on,
 * or null when the file is expected not to exist yet. The file is read again
 * right before the replace, so a change made in between is never overwritten.
 */
export function commitMarkdown(
  root: string,
  relative: string,
  expectedSha256: string | null,
  replacement: Uint8Array,
  options: CommitOptions = {},
): CommitResult {
  const target = resolveMarkdownPath(root, relative, { create: true });
  const conflict = () => new VaultError("CONFLICT", `${relative} changed while this edit was being prepared. Nothing was written; read it again and retry.`);
  return withFileLock(target, () => {
    const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if ((current ? sha256Hex(current) : null) !== expectedSha256) throw conflict();
    const backup = current ? createVerifiedBackup(root, relative, current) : null;
    options.beforeReplace?.();
    const latest = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if ((latest ? sha256Hex(latest) : null) !== expectedSha256) throw conflict();
    if (current) atomicReplace(target, replacement);
    else if (!atomicCreate(target, replacement)) throw conflict();
    const sha256 = sha256Hex(replacement);
    if (sha256Hex(fs.readFileSync(target)) !== sha256) throw new VaultError("CONFLICT", `${relative} did not read back as written.`);
    return { sha256, backup };
  });
}
