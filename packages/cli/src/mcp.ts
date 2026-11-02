/**
 * MCP server over stdio: newline-delimited JSON-RPC 2.0, written by hand so the
 * package has no dependencies. stdout carries only protocol messages.
 */
import { createInterface } from "node:readline";
import { findVaultRoot } from "./hook";
import { addTask, addWorkLog, completeTask, taskView, todayView, type AddTaskInput, type AddWorkLogInput, type CompleteTaskInput } from "./tasks";
import { VaultError, validateVaultRoot } from "./vault-fs";
import { loadVault } from "./vault-read";

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;

const SHA_PROPERTY = { type: "string", description: "Optional. The sha256 you got with the task; the write is refused if the file changed since." };

const TOOLS = [
  {
    name: "get_today",
    description: "Today's most important task (P1), today's tasks, overdue tasks and recent AI handoffs. Call this first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_tasks",
    description: "Find tasks by words in the title, notes or project. Returns ids for complete_task and add_work_log.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to look for. Leave out to list tasks." },
        status: { type: "string", enum: ["open", "done", "all"], description: "Default open." },
        project: { type: "string", description: "Only this project." },
        include_notes: { type: "boolean", description: "Also return each task's notes." },
        limit: { type: "integer", minimum: 1, maximum: SEARCH_MAX_LIMIT, description: `Default ${SEARCH_DEFAULT_LIMIT}.` },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_projects",
    description: "Projects in this vault with status, progress and open task count. Finished projects only on request.",
    inputSchema: {
      type: "object",
      properties: { include_closed: { type: "boolean", description: "Also list done and archived projects." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "add_task",
    description: "Add a task to the vault's inbox file.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "One line." },
        date: { type: "string", description: "YYYY-MM-DD. Leave out for an unscheduled idea." },
        time: { type: "string", description: "Start time, HH:MM." },
        duration_minutes: { type: "integer", minimum: 5, maximum: 1440 },
        priority: { type: "string", enum: ["P1", "P2", "P3", "P4", "P5"], description: "P1 is the one most important task of a day. Default P4." },
        project: { type: "string", description: "Project name." },
        recurrence: { type: "string", description: "For example: every day, every week on Monday, every month on the 5th." },
        notes: { type: "string", description: "Markdown notes under the task." },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "complete_task",
    description: "Mark a task done by id. A repeating task gets its next occurrence automatically.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, expected_sha256: SHA_PROPERTY },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "add_work_log",
    description: "Record what you did, under a task (task_id) or in the AI work log folder when no task matches. A short summary only; never secrets.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: "Your tool name, such as Claude Code or Codex." },
        task_id: { type: "string", description: "The task this work belongs to." },
        title: { type: "string", description: "What the work was. Use it when there is no task_id." },
        done: { type: "string", description: "What you did." },
        result: { type: "string", description: "Where the result is." },
        next: { type: "string", description: "The next step, for whoever picks this up." },
        expected_sha256: SHA_PROPERTY,
      },
      required: ["tool"],
      additionalProperties: false,
    },
  },
];

type ToolArgs = Record<string, unknown>;

function badArgument(message: string): VaultError {
  return new VaultError("INVALID", message);
}

function optionalString(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw badArgument(`${key} must be a string.`);
  return value;
}

function requiredString(args: ToolArgs, key: string): string {
  const value = optionalString(args, key);
  if (!value) throw badArgument(`${key} is required.`);
  return value;
}

function optionalInteger(args: ToolArgs, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) throw badArgument(`${key} must be a whole number.`);
  return value;
}

function getToday(root: string) {
  const state = loadVault(root);
  const view = todayView(state);
  return {
    today: view.today,
    most_important: view.mostImportant ? taskView(state, view.mostImportant) : null,
    today_tasks: view.todayTasks.map((task) => taskView(state, task)),
    overdue: view.overdue.map((task) => taskView(state, task)),
    recent_handoffs: view.handoffs.map((item) => ({
      time: `${item.date} ${item.time}`,
      tool: item.tool,
      task: item.taskTitle,
      next: item.next,
      path: item.sourcePath,
    })),
  };
}

function searchTasks(root: string, args: ToolArgs) {
  const state = loadVault(root);
  const status = optionalString(args, "status") ?? "open";
  if (!["open", "done", "all"].includes(status)) throw badArgument("status must be open, done or all.");
  const words = (optionalString(args, "query") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const project = optionalString(args, "project")?.toLowerCase();
  const limit = Math.min(Math.max(optionalInteger(args, "limit") ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);
  const matches = state.tasks.filter((task) => {
    if (status === "open" && task.status === "done") return false;
    if (status === "done" && task.status !== "done") return false;
    if (project !== undefined && (task.projectName ?? "").toLowerCase() !== project) return false;
    const haystack = `${task.title}\n${task.projectName ?? ""}\n${task.body ?? ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  return {
    total: matches.length,
    tasks: matches.slice(0, limit).map((task) => taskView(state, task, args.include_notes === true)),
  };
}

function listProjects(root: string, args: ToolArgs) {
  const state = loadVault(root);
  const includeClosed = args.include_closed === true;
  return {
    projects: state.projects
      .filter((project) => includeClosed || (project.status !== "done" && project.status !== "archived"))
      .map((project) => ({
        id: project.id,
        name: project.name,
        status: project.status,
        progress: project.progress ?? null,
        focus_today: project.focusToday ?? false,
        open_tasks: state.tasks.filter((task) => task.status !== "done" && task.projectName === project.name).length,
        path: project.sourcePath ?? null,
      })),
  };
}

function toolHandlers(root: string): Record<string, (args: ToolArgs) => unknown> {
  return {
    get_today: () => getToday(root),
    search_tasks: (args) => searchTasks(root, args),
    list_projects: (args) => listProjects(root, args),
    add_task: (args) => addTask(root, {
      title: requiredString(args, "title"),
      date: optionalString(args, "date"),
      time: optionalString(args, "time"),
      duration_minutes: optionalInteger(args, "duration_minutes"),
      priority: optionalString(args, "priority"),
      project: optionalString(args, "project"),
      recurrence: optionalString(args, "recurrence"),
      notes: optionalString(args, "notes"),
    } satisfies AddTaskInput),
    complete_task: (args) => completeTask(root, {
      id: requiredString(args, "id"),
      expected_sha256: optionalString(args, "expected_sha256"),
    } satisfies CompleteTaskInput),
    add_work_log: (args) => addWorkLog(root, {
      tool: optionalString(args, "tool"),
      task_id: optionalString(args, "task_id"),
      title: optionalString(args, "title"),
      done: optionalString(args, "done"),
      result: optionalString(args, "result"),
      next: optionalString(args, "next"),
      expected_sha256: optionalString(args, "expected_sha256"),
    } satisfies AddWorkLogInput),
  };
}

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

function resolveVault(vault: string | undefined): string {
  if (vault !== undefined) {
    const root = validateVaultRoot(vault);
    if (findVaultRoot(root) !== root) {
      throw new VaultError("NOT_FOUND", `${root} is not an aizbrain vault yet. Run: npx aizbrain init "${root}"`);
    }
    return root;
  }
  const found = findVaultRoot(process.cwd());
  if (!found) throw new VaultError("NOT_FOUND", "No aizbrain vault here. Start the server with --vault <folder>, or run: npx aizbrain init");
  return validateVaultRoot(found);
}

function callTool(vault: string | undefined, name: string, args: ToolArgs) {
  try {
    const result = toolHandlers(resolveVault(vault))[name]!(args);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    const message = error instanceof VaultError
      ? error.message
      : `Could not read this vault: ${error instanceof Error ? error.message : String(error)}`;
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

interface RpcError {
  code: number;
  message: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function handleMethod(method: string, params: Record<string, unknown>, vault: string | undefined, version: string): { result: unknown } | { error: RpcError } {
  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      return {
        result: {
          protocolVersion: typeof requested === "string" && SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "aizbrain", version },
          instructions: "Tasks and notes in a local Markdown vault. Call get_today first. After finishing work, call add_work_log so the next AI can pick it up.",
        },
      };
    }
    case "ping":
      return { result: {} };
    case "tools/list":
      return { result: { tools: TOOLS } };
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !TOOL_NAMES.has(name)) return { error: { code: INVALID_PARAMS, message: `Unknown tool: ${String(name)}` } };
      const args = params.arguments ?? {};
      if (!isObject(args)) return { error: { code: INVALID_PARAMS, message: "arguments must be an object." } };
      return { result: callTool(vault, name, args) };
    }
    default:
      return { error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } };
  }
}

/** The reply to one line from the client, or null when none is due. */
export function handleLine(line: string, vault: string | undefined, version: string): string | null {
  const reply = (id: unknown, body: { result: unknown } | { error: RpcError }) => JSON.stringify({ jsonrpc: "2.0", id, ...body });
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return reply(null, { error: { code: PARSE_ERROR, message: "Parse error" } });
  }
  if (!isObject(message)) return reply(null, { error: { code: INVALID_REQUEST, message: "Invalid request" } });
  const { id, method, params, jsonrpc } = message;
  const hasId = id !== undefined;
  // A reply from the client to something we never sent: nothing to do.
  if (method === undefined && hasId && ("result" in message || "error" in message)) return null;
  if (jsonrpc !== "2.0" || typeof method !== "string" || (hasId && typeof id !== "string" && typeof id !== "number")) {
    return reply(typeof id === "string" || typeof id === "number" ? id : null, { error: { code: INVALID_REQUEST, message: "Invalid request" } });
  }
  // Notifications such as notifications/initialized get no reply.
  if (!hasId) return null;
  if (params !== undefined && !isObject(params)) return reply(id, { error: { code: INVALID_PARAMS, message: "params must be an object." } });
  return reply(id, handleMethod(method, params ?? {}, vault, version));
}

/** Serve until the client closes stdin. */
export async function runMcpServer(vault: string | undefined, version: string): Promise<void> {
  // Anything that logs must not corrupt the protocol stream.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;
  process.stdout.on("error", () => process.exit(0));
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const answer = handleLine(line, vault, version);
    if (answer !== null) process.stdout.write(`${answer}\n`);
  }
}
