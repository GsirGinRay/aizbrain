/**
 * Shared by the CLI tests: real bundles in a temp folder, and an environment
 * that points every per-user location at a temp folder too.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { buildCli } from "../scripts/build.mjs";

export const BOM = String.fromCharCode(0xfeff);

const cleanups: string[] = [];
after(() => {
  for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix = "aizbrain-test-"): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(dir);
  return dir;
}

let built: Promise<{ cli: string; hook: string }> | null = null;

export function builtBundles(): Promise<{ cli: string; hook: string }> {
  built ??= (async () => {
    const outdir = tempDir("aizbrain-dist-");
    await buildCli(outdir);
    return { cli: path.join(outdir, "aizbrain.mjs"), hook: path.join(outdir, "aizbrain-hook.mjs") };
  })();
  return built;
}

/** Nothing a test starts can reach the real home folder or tool settings. */
export function isolatedEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.GEMINI_PROJECT_DIR;
  delete env.NODE_OPTIONS;
  return { ...env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData"), CODEX_HOME: path.join(home, "codex-home"), ...extra };
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function runNode(script: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; cwd?: string; input?: string }): RunResult {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: options.env, cwd: options.cwd, input: options.input ?? "", windowsHide: true });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function writeFile(root: string, relative: string, content: string | Buffer): string {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export function readFile(root: string, relative: string): string {
  return fs.readFileSync(path.join(root, ...relative.split("/")), "utf8");
}

export function fileSnapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out.set(path.relative(root, full).split(path.sep).join("/"), fs.readFileSync(full).toString("base64"));
  }
  return out;
}

export interface McpReply {
  jsonrpc: string;
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string };
}

/** A minimal MCP client talking to a spawned server over real pipes. */
export class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private readonly waiting: ((reply: McpReply) => void)[] = [];
  private readonly queued: McpReply[] = [];
  private nextId = 1;
  stderr = "";

  constructor(cli: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd?: string) {
    this.child = spawn(process.execPath, [cli, "mcp", ...args], { env, cwd, windowsHide: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
        const reply = JSON.parse(this.buffer.slice(0, at)) as McpReply;
        this.buffer = this.buffer.slice(at + 1);
        const resolve = this.waiting.shift();
        if (resolve) resolve(reply);
        else this.queued.push(reply);
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
  }

  sendRaw(line: string): void {
    this.child.stdin.write(`${line}\n`);
  }

  nextReply(): Promise<McpReply> {
    const ready = this.queued.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  request(method: string, params?: unknown): Promise<McpReply> {
    const id = this.nextId;
    this.nextId += 1;
    this.sendRaw(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
    return this.nextReply();
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<{ data: any; isError: boolean; text: string }> {
    const reply = await this.request("tools/call", { name, arguments: args });
    const text = reply.result.content[0].text as string;
    const isError = reply.result.isError === true;
    return { data: isError ? null : JSON.parse(text), isError, text };
  }

  close(): Promise<number | null> {
    return new Promise((resolve) => {
      this.child.on("exit", (code) => resolve(code));
      this.child.stdin.end();
    });
  }
}
