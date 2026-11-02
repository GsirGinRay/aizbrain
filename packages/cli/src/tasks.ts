/**
 * The vault changes an AI can ask for: add a task, complete a task, write a work
 * log. Each edits the bytes on disk as narrowly as it can: only the lines it adds
 * or changes differ, so BOM, line endings, indentation, unknown tokens and
 * unrelated text stay as they were, and tasks without an id elsewhere in the file
 * are not touched.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  aiWorklogPath,
  endIndexOfTaskBody,
  formatRecurrence,
  formatTaskLine,
  isValidDateKey,
  parseRecurrence,
  parseTaskLine,
  patchTaskLineMinimal,
  rankForIndex,
  recentAiHandoffs,
  resolveInboxWritePath,
  templatePacks,
  type BrainTaskSnapshot,
  type TaskPriority,
} from "@second-brain/brain-core";
import { closedProjectIds, withRecurringFollowUps } from "../../../apps/desktop/src/recurring-tasks";
import { loadVault, localDateKey, localTimeKey, type VaultState } from "./vault-read";
import { commitMarkdown, resolveMarkdownPath, sha256Hex, VaultError, type CommitOptions } from "./vault-fs";

const TASK_BODY_INDENT = "  ";
const PRIORITY_CODES: Record<TaskPriority, string> = { highest: "P1", high: "P2", medium: "P3", normal: "P4", low: "P5" };
const PRIORITY_BY_CODE: Record<string, TaskPriority> = { P1: "highest", P2: "high", P3: "medium", P4: "normal", P5: "low" };

function invalid(message: string): VaultError {
  return new VaultError("INVALID", message);
}

/** One line of plain text: control characters and line breaks become spaces. */
function inlineText(value: string, field: string, maxLength: number): string {
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (text.length > maxLength) throw invalid(`${field} is too long (at most ${maxLength} characters).`);
  return text;
}

interface SourceLine {
  text: string;
  eol: string;
}

/** Split text keeping each line's own ending, so a mixed file stays exactly as it was. */
function splitWithEndings(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const pattern = /\r?\n/g;
  let start = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    lines.push({ text: text.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: "" });
  return lines;
}

function joinWithEndings(lines: readonly SourceLine[]): string {
  return lines.map((line) => line.text + line.eol).join("");
}

function splitBom(text: string): { bom: string; content: string } {
  return text.startsWith("\uFEFF") ? { bom: "\uFEFF", content: text.slice(1) } : { bom: "", content: text };
}

function fileNewline(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Append lines at the end of the file, adding a missing final line break first. */
function appendLines(content: string, added: readonly string[], newline: string): string {
  const head = content.length > 0 && !content.endsWith("\n") ? content + newline : content;
  return head + added.map((line) => line + newline).join("");
}

/** A task line and its notes, indented the way the desktop writes them. */
function taskBlockLines(line: string, body: string | undefined): string[] {
  const lines = [line];
  if (body?.trim()) {
    for (const raw of body.replace(/\r?\n/g, "\n").replace(/^\n+|\n+$/g, "").split("\n")) {
      const trimmed = raw.replace(/[ \t]+$/g, "");
      lines.push(trimmed ? TASK_BODY_INDENT + trimmed : TASK_BODY_INDENT);
    }
  }
  return lines;
}

export interface TaskView {
  id: string;
  title: string;
  status: string;
  date: string | null;
  time: string | null;
  duration_minutes: number | null;
  priority: string;
  project: string | null;
  recurrence: string | null;
  path: string | null;
  /** Hash of the file holding the task; pass it back as `expected_sha256` to guard an edit. */
  sha256: string | null;
  notes?: string;
}

export function taskView(state: VaultState, task: BrainTaskSnapshot, includeNotes = false): TaskView {
  return {
    id: task.id!,
    title: task.title,
    status: task.status,
    date: task.taskDate ?? null,
    time: task.startTime ?? null,
    duration_minutes: task.durationMinutes ?? null,
    priority: PRIORITY_CODES[task.priority] ?? "P4",
    project: task.projectName ?? null,
    recurrence: task.recurrence ?? null,
    path: task.sourcePath ?? null,
    sha256: task.sourcePath ? state.files.get(task.sourcePath)?.sha256 ?? null : null,
    ...(includeNotes && task.body ? { notes: task.body } : {}),
  };
}

function byTime(left: BrainTaskSnapshot, right: BrainTaskSnapshot): number {
  return (left.taskDate ?? "").localeCompare(right.taskDate ?? "")
    || (left.startTime ?? "99:99").localeCompare(right.startTime ?? "99:99")
    || left.rank.localeCompare(right.rank);
}

export interface TodayView {
  today: string;
  mostImportant: BrainTaskSnapshot | null;
  todayTasks: BrainTaskSnapshot[];
  overdue: BrainTaskSnapshot[];
  handoffs: ReturnType<typeof recentAiHandoffs>;
}

/** The same picture as the "today" part of `.ai/INDEX.md`. */
export function todayView(state: VaultState): TodayView {
  const open = state.tasks.filter((task) => task.status !== "done");
  const p1 = state.tasks.filter((task) => task.priority === "highest" && task.taskDate === state.today).sort(byTime);
  return {
    today: state.today,
    mostImportant: p1.find((task) => task.status !== "done") ?? p1[0] ?? null,
    todayTasks: open.filter((task) => task.taskDate === state.today).sort(byTime),
    overdue: open.filter((task) => task.taskDate && task.taskDate < state.today).sort(byTime),
    handoffs: recentAiHandoffs(state.tasks),
  };
}

export interface AddTaskInput {
  title: string;
  date?: string;
  time?: string;
  duration_minutes?: number;
  priority?: string;
  project?: string;
  recurrence?: string;
  notes?: string;
}

export interface WriteOptions extends CommitOptions {
  now?: Date;
}

/** Add a task to the inbox file of this vault's language. */
export function addTask(root: string, input: AddTaskInput, options: WriteOptions = {}) {
  const now = options.now ?? new Date();
  const state = loadVault(root, now);
  const title = inlineText(input.title, "title", 300);
  if (!title) throw invalid("title must not be empty.");
  if (input.date !== undefined && !isValidDateKey(input.date)) throw invalid("date must look like 2026-10-25.");
  if (input.time !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw invalid("time must look like 09:30.");
  const duration = input.duration_minutes;
  if (duration !== undefined && (!Number.isInteger(duration) || duration < 5 || duration > 1440)) throw invalid("duration_minutes must be a whole number from 5 to 1440.");
  const code = (input.priority ?? "P4").toUpperCase();
  let priority = PRIORITY_BY_CODE[code];
  if (!priority) throw invalid("priority must be P1, P2, P3, P4 or P5.");
  const rule = input.recurrence === undefined ? null : parseRecurrence(input.recurrence);
  if (input.recurrence !== undefined && !rule) throw invalid("recurrence must look like: every day, every week on Monday, every month on the 5th.");
  // The same two limits the desktop's note writer has.
  if (input.notes !== undefined && input.notes.length > 2_000_000) throw invalid("notes are too long.");
  if (input.notes?.includes("<!-- second-brain-task-content:")) throw invalid("notes must not contain second-brain-task-content comments.");
  const notes: string[] = [];
  // A repeating or most-important task needs a day; the others may stay unscheduled.
  const date = input.date ?? (rule || priority === "highest" ? state.today : null);
  // A day owns one P1, and an AI should not take it from the task the user chose.
  if (priority === "highest" && state.tasks.some((task) => task.priority === "highest" && task.status !== "done" && task.taskDate === date)) {
    priority = "high";
    notes.push(`${date} already has a P1, so this task was added as P2.`);
  }
  let project: string | null = null;
  if (input.project !== undefined) {
    const wanted = inlineText(input.project, "project", 200).replace(/[[\]]/g, "");
    const known = state.projects.find((item) => item.name.toLowerCase() === wanted.toLowerCase());
    project = known?.name ?? (wanted || null);
    if (project && !known) notes.push(`No project named "${project}" exists yet; the task links to that name.`);
  }
  const task: BrainTaskSnapshot = {
    id: randomUUID(),
    title,
    status: "todo",
    taskDate: date,
    priority,
    projectId: null,
    projectName: project,
    rank: rankForIndex(state.tasks.length),
    sourcePath: null,
    sourceHeading: null,
    completedAt: null,
    startTime: input.time ?? null,
    durationMinutes: duration ?? (input.time ? 30 : null),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Taipei",
    schemaVersion: 6,
    ...(rule ? { recurrence: formatRecurrence(rule) } : {}),
  };
  const relative = resolveInboxWritePath([...state.files.keys()]);
  const existing = state.files.get(relative);
  const starter = templatePacks(state.locale).find((pack) => pack.id === "projects")?.files[relative] ?? "";
  const { bom, content } = splitBom(existing?.text ?? starter);
  const next = bom + appendLines(content, taskBlockLines(formatTaskLine(task), input.notes), fileNewline(content));
  const commit = commitMarkdown(state.root, relative, existing?.sha256 ?? null, Buffer.from(next, "utf8"), options);
  return {
    task: { ...taskView(state, { ...task, sourcePath: relative }), sha256: commit.sha256 },
    backup: commit.backup,
    ...(notes.length ? { notes } : {}),
  };
}

export interface CompleteTaskInput {
  id: string;
  expected_sha256?: string;
}

function locateTask(state: VaultState, id: string, expected: string | undefined) {
  const location = state.locations.get(id);
  const task = state.tasks.find((item) => item.id === id);
  if (!location || !task) throw new VaultError("NOT_FOUND", `No task with id ${id}. It may have been edited; search again for its current id.`);
  const file = state.files.get(location.relativePath)!;
  if (expected !== undefined && expected !== file.sha256) {
    throw new VaultError("CONFLICT", `${location.relativePath} changed since you read it. Nothing was written; read it again and retry.`);
  }
  return { location, task, file };
}

/** Tick a task. A repeating task also gets its next occurrence, the same way the desktop adds it. */
export function completeTask(root: string, input: CompleteTaskInput, options: WriteOptions = {}) {
  const now = options.now ?? new Date();
  const state = loadVault(root, now);
  const { location, task, file } = locateTask(state, input.id, input.expected_sha256);
  if (task.status === "done") return { task: taskView(state, task), already_done: true, next_occurrence: null, backup: null };
  const today = localDateKey(now);
  const completed: BrainTaskSnapshot = { ...task, status: "done", completedAt: today };
  const { bom, content } = splitBom(file.text);
  const lines = splitWithEndings(content);
  const line = lines[location.lineIndex];
  if (!line || !parseTaskLine(line.text, location.relativePath, location.lineIndex)) {
    throw new VaultError("NOT_FOUND", `Could not find the line of task ${input.id}.`);
  }
  // Give it its id first, as the desktop's scan would, so the tokens land in the usual order.
  line.text = patchTaskLineMinimal(patchTaskLineMinimal(line.text, task), completed);
  const followUps = withRecurringFollowUps(
    state.tasks,
    state.tasks.map((item) => (item.id === task.id ? completed : item)),
    today,
    { closedProjectIds: closedProjectIds(state.projects) },
  ).filter((item) => !state.locations.has(item.id!));
  const newline = fileNewline(content);
  const next = bom + appendLines(
    joinWithEndings(lines),
    followUps.flatMap((item) => taskBlockLines(formatTaskLine({ ...item, sourcePath: location.relativePath }), item.body)),
    newline,
  );
  const commit = commitMarkdown(state.root, location.relativePath, file.sha256, Buffer.from(next, "utf8"), options);
  const follow = followUps[0];
  return {
    task: { ...taskView(state, completed), sha256: commit.sha256 },
    already_done: false,
    next_occurrence: follow ? { ...taskView(state, follow), path: location.relativePath, sha256: commit.sha256 } : null,
    backup: commit.backup,
  };
}

export interface AddWorkLogInput {
  tool?: string;
  task_id?: string;
  title?: string;
  done?: string;
  result?: string;
  next?: string;
  expected_sha256?: string;
}

function workLogBlock(state: VaultState, input: AddWorkLogInput, now: Date): { heading: string; items: string[] } {
  const tool = inlineText(input.tool ?? "AI", "tool", 40).replace(/[()（）]/g, "") || "AI";
  const stamp = `${localDateKey(now)} ${localTimeKey(now)}`;
  const zh = state.locale !== "en";
  const items: string[] = [];
  const add = (label: string, value: string | undefined, field: string) => {
    const text = value === undefined ? "" : inlineText(value, field, 4000);
    if (text) items.push(`- ${label}${text}`);
  };
  add(zh ? "做了什麼：" : "Done: ", input.done, "done");
  add(zh ? "結果在哪：" : "Result: ", input.result, "result");
  add(zh ? "下一步：" : "Next: ", input.next, "next");
  if (items.length === 0) throw invalid("Write at least one of done, result or next.");
  const title = input.title === undefined ? "" : inlineText(input.title, "title", 200);
  const heading = zh ? `### AI 工作紀錄 ${stamp}（${tool}）` : `### AI work log ${stamp} (${tool})`;
  return { heading: title ? `${heading} ${title}` : heading, items };
}

/** Write a work log under a task, or in `.ai/worklog/YYYY-MM.md` when no task matches. */
export function addWorkLog(root: string, input: AddWorkLogInput, options: WriteOptions = {}) {
  const now = options.now ?? new Date();
  const state = loadVault(root, now);
  const block = workLogBlock(state, input, now);
  const blockLines = [block.heading, "", ...block.items];

  if (input.task_id === undefined) {
    const relative = aiWorklogPath(localDateKey(now));
    const target = resolveMarkdownPath(state.root, relative, { create: true });
    const bytes = fs.existsSync(target) ? fs.readFileSync(target) : null;
    const { bom, content } = splitBom(bytes?.toString("utf8") ?? "");
    const newline = fileNewline(content);
    const separator = content.trim() ? [""] : [];
    const next = bom + appendLines(content, [...separator, ...blockLines], newline);
    const commit = commitMarkdown(state.root, relative, bytes ? sha256Hex(bytes) : null, Buffer.from(next, "utf8"), options);
    return { path: relative, task_id: null, heading: block.heading, sha256: commit.sha256, backup: commit.backup };
  }

  const { location, file } = locateTask(state, input.task_id, input.expected_sha256);
  const { bom, content } = splitBom(file.text);
  const lines = splitWithEndings(content);
  const plain = content.split(/\r?\n/);
  const insertAt = Math.min(endIndexOfTaskBody(plain, location.lineIndex), lines.length);
  const previous = lines[insertAt - 1]!;
  const neighbourEol = previous.eol || fileNewline(content);
  const indented = ["", ...blockLines.map((line) => (line ? TASK_BODY_INDENT + line : ""))];
  const added: SourceLine[] = indented.map((text) => ({ text, eol: neighbourEol }));
  if (!previous.eol) {
    // The file had no final line break; keep it that way.
    previous.eol = neighbourEol;
    added[added.length - 1]!.eol = "";
  }
  lines.splice(insertAt, 0, ...added);
  const next = bom + joinWithEndings(lines);
  const commit = commitMarkdown(state.root, location.relativePath, file.sha256, Buffer.from(next, "utf8"), options);
  return { path: location.relativePath, task_id: input.task_id, heading: block.heading, sha256: commit.sha256, backup: commit.backup };
}
