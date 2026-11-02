import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { tempDir, writeFile } from "./test-support";
import {
  atomicCreate,
  atomicReplace,
  commitMarkdown,
  createVerifiedBackup,
  resolveMarkdownPath,
  scanMarkdown,
  sha256Hex,
  validateRelativePath,
  validateVaultRoot,
  VaultError,
} from "./vault-fs";
import { localeFromTag } from "./vault-read";

const isCode = (code: string) => (error: unknown) => error instanceof VaultError && error.code === code;

function makeLink(target: string, link: string, kind: "junction" | "file" = "junction"): boolean {
  try {
    fs.symlinkSync(target, link, kind);
    return true;
  } catch {
    return false;
  }
}

describe("vault paths", () => {
  it("accepts ordinary and managed Markdown paths", () => {
    for (const good of ["Inbox/Inbox.md", "收件匣/待辦.md", ".ai/worklog/2026-10.md", ".ai/INDEX.md", "CLAUDE.md", "Templates/x.md", "a b/c d.md"]) {
      assert.doesNotThrow(() => validateRelativePath(good), good);
    }
  });

  it("refuses escapes, absolute paths and technical folders", () => {
    for (const bad of [
      "", "../x.md", "a/../../x.md", "a/../x.md", "./x.md", "/etc/x.md", "C:/x.md", String.raw`C:\x.md`, String.raw`a\x.md`, "a//x.md",
      "a:b.md", "x\0.md", ".git/x.md", ".obsidian/x.md", "node_modules/x.md", ".hidden/x.md", "a/.secret/x.md", "x.txt", "x", "x.MD",
    ]) {
      assert.throws(() => validateRelativePath(bad), isCode("UNSAFE_PATH"), JSON.stringify(bad));
    }
  });

  it("refuses a file used as a folder, and a folder used as a file", () => {
    const root = tempDir();
    writeFile(root, "note.md", "x");
    fs.mkdirSync(path.join(root, "dir.md"));
    assert.throws(() => resolveMarkdownPath(root, "note.md/inner.md"), isCode("UNSAFE_PATH"));
    assert.throws(() => resolveMarkdownPath(root, "dir.md"), isCode("UNSAFE_PATH"));
  });

  it("refuses a linked or hidden vault root and technical root names", (t) => {
    const parent = tempDir();
    const real = path.join(parent, "real");
    fs.mkdirSync(real);
    assert.equal(validateVaultRoot(real), fs.realpathSync.native(real));
    fs.mkdirSync(path.join(parent, ".hidden"));
    assert.throws(() => validateVaultRoot(path.join(parent, ".hidden")), isCode("UNSAFE_PATH"));
    fs.mkdirSync(path.join(parent, "node_modules"));
    assert.throws(() => validateVaultRoot(path.join(parent, "node_modules")), isCode("UNSAFE_PATH"));
    assert.throws(() => validateVaultRoot(path.join(parent, "missing")), isCode("UNSAFE_PATH"));
    if (!makeLink(real, path.join(parent, "link"))) {
      t.skip("cannot create links here");
      return;
    }
    assert.throws(() => validateVaultRoot(path.join(parent, "link")), isCode("UNSAFE_PATH"));
  });

  it("refuses a link or junction anywhere on the way, even for a new file", (t) => {
    const root = tempDir();
    const outside = tempDir();
    writeFile(outside, "secret.md", "outside");
    if (!makeLink(outside, path.join(root, "linked"))) {
      t.skip("cannot create links here");
      return;
    }
    assert.throws(() => resolveMarkdownPath(root, "linked/secret.md"), isCode("UNSAFE_PATH"));
    assert.throws(() => resolveMarkdownPath(root, "linked/new.md", { create: true }), isCode("UNSAFE_PATH"));
    assert.throws(() => commitMarkdown(root, "linked/secret.md", sha256Hex(Buffer.from("outside")), Buffer.from("x")), isCode("UNSAFE_PATH"));
    assert.equal(fs.readFileSync(path.join(outside, "secret.md"), "utf8"), "outside");
  });

  it("refuses a linked file", (t) => {
    const root = tempDir();
    const outside = writeFile(tempDir(), "secret.md", "outside");
    if (!makeLink(outside, path.join(root, "note.md"), "file")) {
      t.skip("this account cannot create file links");
      return;
    }
    assert.throws(() => resolveMarkdownPath(root, "note.md"), isCode("UNSAFE_PATH"));
  });

  it("refuses a folder with the Windows Hidden flag", { skip: process.platform !== "win32" }, () => {
    const root = tempDir();
    writeFile(root, "secret stuff/note.md", "x");
    assert.doesNotThrow(() => resolveMarkdownPath(root, "secret stuff/note.md"));
    const attrib = spawnSync("attrib", ["+h", path.join(root, "secret stuff")]);
    assert.equal(attrib.status, 0);
    assert.throws(() => resolveMarkdownPath(root, "secret stuff/note.md"), isCode("UNSAFE_PATH"));
    const parent = tempDir();
    fs.mkdirSync(path.join(parent, "hidden root"));
    spawnSync("attrib", ["+h", path.join(parent, "hidden root")]);
    assert.throws(() => validateVaultRoot(path.join(parent, "hidden root")), isCode("UNSAFE_PATH"));
  });
});

describe("scan", () => {
  it("reads content Markdown only, and skips what it must", (t) => {
    const root = tempDir();
    writeFile(root, "Inbox/Inbox.md", "a");
    writeFile(root, "Projects/p.md", "b");
    writeFile(root, "CLAUDE.md", "skip: entry file");
    writeFile(root, ".ai/INDEX.md", "skip: hidden");
    writeFile(root, ".git/x.md", "skip");
    writeFile(root, "node_modules/x/README.md", "skip");
    writeFile(root, "Templates/t.md", "skip");
    writeFile(root, "old-backup/x.md", "skip");
    writeFile(root, "notes.txt", "skip");
    writeFile(root, "bad.md", Buffer.from([0xff, 0xfe, 0x00]));
    const outside = tempDir();
    writeFile(outside, "secret.md", "- [ ] #task secret");
    const linked = makeLink(outside, path.join(root, "linked"));
    const { files, skipped } = scanMarkdown(root);
    assert.deepEqual(files.map((file) => file.relativePath), ["Inbox/Inbox.md", "Projects/p.md"]);
    assert.ok(skipped.includes("bad.md"));
    if (linked) assert.ok(skipped.includes("linked"));
    else t.diagnostic("no link test: cannot create links here");
  });
});

describe("writes", () => {
  const sha = (text: string) => sha256Hex(Buffer.from(text));

  it("backs up, verifies and replaces", () => {
    const root = tempDir();
    const file = writeFile(root, "Inbox/Inbox.md", "old");
    const result = commitMarkdown(root, "Inbox/Inbox.md", sha("old"), Buffer.from("new"));
    assert.equal(fs.readFileSync(file, "utf8"), "new");
    assert.equal(result.sha256, sha("new"));
    const backupDir = path.join(root, ...result.backup!.split("/"));
    assert.equal(fs.readFileSync(path.join(backupDir, "Inbox", "Inbox.md"), "utf8"), "old");
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.entries, [{ relative_path: "Inbox/Inbox.md", sha256: sha("old"), bytes: 3 }]);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["Inbox.md"], "no temp or lock file left behind");
  });

  it("refuses when the file is not what the edit was based on", () => {
    const root = tempDir();
    const file = writeFile(root, "a.md", "theirs");
    assert.throws(() => commitMarkdown(root, "a.md", sha("mine"), Buffer.from("new")), isCode("CONFLICT"));
    assert.equal(fs.readFileSync(file, "utf8"), "theirs");
    assert.ok(!fs.existsSync(path.join(root, ".ai")), "no backup for a refused write");
  });

  it("re-reads right before replacing, so a change made after the backup is kept", () => {
    const root = tempDir();
    const file = writeFile(root, "a.md", "old");
    assert.throws(() => commitMarkdown(root, "a.md", sha("old"), Buffer.from("new"), {
      beforeReplace: () => fs.writeFileSync(file, "someone else"),
    }), isCode("CONFLICT"));
    assert.equal(fs.readFileSync(file, "utf8"), "someone else");
  });

  it("refuses to create over a file that appeared meanwhile", () => {
    const root = tempDir();
    const file = writeFile(root, "a.md", "theirs");
    assert.throws(() => commitMarkdown(root, "a.md", null, Buffer.from("new")), isCode("CONFLICT"));
    fs.rmSync(file);
    assert.throws(() => commitMarkdown(root, "a.md", null, Buffer.from("new"), {
      beforeReplace: () => fs.writeFileSync(file, "theirs"),
    }), isCode("CONFLICT"));
    assert.equal(fs.readFileSync(file, "utf8"), "theirs");
  });

  it("waits for the desktop's lock file, then gives up without writing", () => {
    const root = tempDir();
    const file = writeFile(root, "a.md", "old");
    writeFile(root, "a.publisher-sync.lock", "");
    assert.throws(() => commitMarkdown(root, "a.md", sha("old"), Buffer.from("new")), isCode("LOCKED"));
    assert.equal(fs.readFileSync(file, "utf8"), "old");
  });

  it("takes over a lock left behind by a crash", () => {
    const root = tempDir();
    writeFile(root, "a.md", "old");
    const lock = writeFile(root, "a.publisher-sync.lock", "");
    const stale = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, stale, stale);
    commitMarkdown(root, "a.md", sha("old"), Buffer.from("new"));
    assert.ok(!fs.existsSync(lock));
  });

  it("refuses a backup folder that is a link", (t) => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, ".ai"));
    const outside = tempDir();
    if (!makeLink(outside, path.join(root, ".ai", "backups"))) {
      t.skip("cannot create links here");
      return;
    }
    writeFile(root, "a.md", "old");
    assert.throws(() => commitMarkdown(root, "a.md", sha("old"), Buffer.from("new")), isCode("UNSAFE_PATH"));
    assert.equal(fs.readFileSync(path.join(root, "a.md"), "utf8"), "old");
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  it("keeps the newest 50 backups", () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, ".ai", "backups"), { recursive: true });
    for (let index = 0; index < 55; index += 1) {
      fs.mkdirSync(path.join(root, ".ai", "backups", `20200101T0000${String(index).padStart(2, "0")}-00000000`));
    }
    fs.mkdirSync(path.join(root, ".ai", "backups", "user-folder"));
    createVerifiedBackup(root, "a.md", Buffer.from("x"));
    const names = fs.readdirSync(path.join(root, ".ai", "backups"));
    assert.equal(names.filter((name) => name !== "user-folder").length, 50);
    assert.ok(names.includes("user-folder"));
  });

  it("creates without ever overwriting", () => {
    const root = tempDir();
    const file = path.join(root, "a.md");
    assert.equal(atomicCreate(file, Buffer.from("first")), true);
    assert.equal(atomicCreate(file, Buffer.from("second")), false);
    assert.equal(fs.readFileSync(file, "utf8"), "first");
    assert.deepEqual(fs.readdirSync(root), ["a.md"]);
  });

  it("replaces bytes exactly", () => {
    const root = tempDir();
    const file = writeFile(root, "a.md", "x");
    const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
    atomicReplace(file, bytes);
    assert.ok(fs.readFileSync(file).equals(bytes));
  });
});

describe("system locale", () => {
  it("maps Traditional Chinese regions to zh-TW and everything else to en", () => {
    for (const tag of ["zh-TW", "zh-Hant", "zh-Hant-TW", "zh-HK", "zh_TW"]) assert.equal(localeFromTag(tag), "zh-TW", tag);
    for (const tag of ["en", "en-US", "ja-JP", "zh-CN", "zh", undefined]) assert.equal(localeFromTag(tag), "en", String(tag));
  });
});
