import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, before, describe, it } from "node:test";
import { nextOccurrence, parseAiWorklog, parseRecurrence, parseTaskLine } from "@second-brain/brain-core";
import { BOM, builtBundles, fileSnapshot, isolatedEnv, McpClient, readFile, runNode, tempDir, writeFile } from "./test-support";
import { localDateKey } from "./vault-read";

const today = localDateKey(new Date());

let cli: string;
before(async () => {
  ({ cli } = await builtBundles());
});

const clients: McpClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function vault(locale: "en" | "zh-TW" = "en"): { root: string; env: NodeJS.ProcessEnv } {
  const home = tempDir();
  const env = isolatedEnv(home);
  const root = path.join(tempDir(), "vault");
  const out = runNode(cli, ["init", root, "--no-hooks", "--locale", locale], { env, cwd: home });
  assert.equal(out.status, 0, out.stderr);
  // These tests start from a folder with no inbox and no tasks.
  fs.rmSync(path.join(root, locale === "en" ? "Inbox" : "收件匣"), { recursive: true });
  return { root, env };
}

async function connect(root: string, env: NodeJS.ProcessEnv): Promise<McpClient> {
  const client = new McpClient(cli, ["--vault", root], env);
  clients.push(client);
  const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.ok(init.result);
  client.sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return client;
}

async function server(locale: "en" | "zh-TW" = "en") {
  const { root, env } = vault(locale);
  return { root, env, client: await connect(root, env) };
}

function backupCount(root: string): number {
  const dir = path.join(root, ".ai", "backups");
  return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
}

describe("protocol", () => {
  it("does the handshake and lists the tools", async () => {
    const { root, env } = vault();
    const client = new McpClient(cli, ["--vault", root], env);
    clients.push(client);
    const init = await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(init.jsonrpc, "2.0");
    assert.equal(init.id, 1);
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.serverInfo.name, "aizbrain");
    assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+$/);
    client.sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    const pong = await client.request("ping");
    assert.equal(pong.id, 2, "the notification got no reply of its own");
    assert.deepEqual(pong.result, {});
    const listed = await client.request("tools/list");
    assert.deepEqual(listed.result.tools.map((tool: any) => tool.name).sort(), ["add_task", "add_work_log", "complete_task", "get_today", "list_projects", "search_tasks"]);
    for (const tool of listed.result.tools) {
      assert.ok(tool.description.length > 0 && tool.description.length < 160, tool.name);
      assert.equal(tool.inputSchema.type, "object");
    }
  });

  it("offers its newest protocol for one it does not know", async () => {
    const { root, env } = vault();
    const client = new McpClient(cli, ["--vault", root], env);
    clients.push(client);
    const init = await client.request("initialize", { protocolVersion: "1999-01-01" });
    assert.equal(init.result.protocolVersion, "2025-11-25");
  });

  it("gives the right errors", async () => {
    const { client } = await server();
    client.sendRaw("{not json");
    let reply = await client.nextReply();
    assert.equal(reply.error!.code, -32700);
    assert.equal(reply.id, null);
    client.sendRaw("[1,2]");
    assert.equal((await client.nextReply()).error!.code, -32600);
    client.sendRaw(JSON.stringify({ jsonrpc: "1.0", id: 9, method: "ping" }));
    reply = await client.nextReply();
    assert.equal(reply.error!.code, -32600);
    assert.equal(reply.id, 9);
    client.sendRaw(JSON.stringify({ jsonrpc: "2.0", id: 10, method: 5 }));
    assert.equal((await client.nextReply()).error!.code, -32600);
    assert.equal((await client.request("no/such/method")).error!.code, -32601);
    assert.equal((await client.request("tools/call", { name: "no_such_tool", arguments: {} })).error!.code, -32602);
    assert.equal((await client.request("tools/call", { name: "get_today", arguments: 5 })).error!.code, -32602);
    client.sendRaw(JSON.stringify({ jsonrpc: "2.0", id: 11, method: "ping", params: [1] }));
    assert.equal((await client.nextReply()).error!.code, -32602);
    // A reply from the client and an unknown notification get nothing back.
    client.sendRaw(JSON.stringify({ jsonrpc: "2.0", id: 12, result: {} }));
    client.sendRaw(JSON.stringify({ jsonrpc: "2.0", method: "notifications/unknown" }));
    assert.deepEqual((await client.request("ping")).result, {});
  });

  it("reports a tool problem as a tool error, and stays up", async () => {
    const { client } = await server();
    const bad = await client.call("add_task", { title: "" });
    assert.equal(bad.isError, true);
    assert.ok(bad.text.includes("title"));
    assert.equal((await client.call("add_task", { title: 5 })).isError, true);
    assert.equal((await client.call("add_task", { title: "x", date: "tomorrow" })).isError, true);
    assert.equal((await client.call("add_task", { title: "x", priority: "urgent" })).isError, true);
    assert.equal((await client.call("add_task", { title: "x", recurrence: "sometimes" })).isError, true);
    assert.equal((await client.call("add_task", { title: "x", notes: "<!-- second-brain-task-content:a:start -->" })).isError, true);
    assert.equal((await client.call("complete_task", { id: "nope" })).isError, true);
    assert.equal((await client.call("add_work_log", { tool: "T" })).isError, true);
    assert.deepEqual((await client.request("ping")).result, {});
  });

  it("explains a missing vault, and finds one from the current folder", async () => {
    const home = tempDir();
    const env = isolatedEnv(home);
    const lost = new McpClient(cli, [], env, tempDir());
    clients.push(lost);
    const missing = await lost.call("get_today");
    assert.equal(missing.isError, true);
    assert.ok(missing.text.includes("aizbrain init"));
    const notVault = new McpClient(cli, ["--vault", tempDir()], env);
    clients.push(notVault);
    assert.ok((await notVault.call("get_today")).text.includes("aizbrain init"));
    const { root } = vault();
    const found = new McpClient(cli, [], env, path.join(root, ".ai"));
    clients.push(found);
    assert.equal((await found.call("get_today")).isError, false);
  });

  it("keeps stdout to protocol messages and exits when stdin closes", async () => {
    const { root, env } = vault();
    const lines = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "add_task", arguments: { title: "Task with 中文" } } }),
      "",
    ].join("\n");
    const out = runNode(cli, ["mcp", "--vault", root], { env, input: lines });
    assert.equal(out.status, 0);
    assert.equal(out.stderr, "");
    const replies = out.stdout.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(replies.map((reply) => reply.id), [1, 2]);
  });
});

describe("get_today, search_tasks, list_projects", () => {
  function fill(root: string): void {
    writeFile(root, "Inbox/Inbox.md", [
      "# Inbox",
      "",
      `- [ ] #task Big one 🔺 ⏳ ${today}`,
      "",
      "  ### AI work log 2026-10-24 09:00 (Codex)",
      "",
      "  - Next: review the draft",
      "",
      `- [ ] #task Later one ⏳ ${today} ⏰ 09:30 ⏱ 45m`,
      "- [ ] #task Overdue one ⏳ 2020-01-01",
      "- [ ] #task Idea without a date [[Launch]]",
      `- [x] #task Finished one ⏳ ${today} ✅ ${today}`,
      "",
      "```",
      "- [ ] #task Example in a code block",
      "```",
      "",
    ].join("\n"));
    writeFile(root, "Projects/Launch.md", "---\ntype: project\nid: p-1\nstatus: active\nprogress: 40\n---\n# Launch\n\n- [ ] #task Project task\n");
    writeFile(root, "Projects/Old.md", "---\ntype: project\nid: p-2\nstatus: done\n---\n# Old\n");
    writeFile(root, "Templates/t.md", "- [ ] #task In a template\n");
  }

  it("get_today matches the vault and writes nothing", async () => {
    const { root, client } = await server();
    fill(root);
    const before = fileSnapshot(root);
    const { data } = await client.call("get_today");
    assert.equal(data.today, today);
    assert.equal(data.most_important.title, "Big one");
    assert.equal(data.most_important.priority, "P1");
    assert.deepEqual(data.today_tasks.map((task: any) => task.title), ["Later one", "Big one"]);
    assert.equal(data.today_tasks[0].time, "09:30");
    assert.equal(data.today_tasks[0].duration_minutes, 45);
    assert.deepEqual(data.overdue.map((task: any) => task.title), ["Overdue one"]);
    assert.equal(data.recent_handoffs[0].next, "review the draft");
    assert.equal(data.recent_handoffs[0].tool, "Codex");
    assert.deepEqual(fileSnapshot(root), before);
  });

  it("search_tasks filters by words, project and status, and leaves out examples and templates", async () => {
    const { root, client } = await server();
    fill(root);
    assert.deepEqual((await client.call("search_tasks", { query: "BIG" })).data.tasks.map((task: any) => task.title), ["Big one"]);
    assert.equal((await client.call("search_tasks", { query: "review draft" })).data.tasks[0].title, "Big one", "looks in notes");
    assert.deepEqual((await client.call("search_tasks", { project: "launch" })).data.tasks.map((task: any) => task.title), ["Idea without a date"]);
    assert.deepEqual((await client.call("search_tasks", { status: "done" })).data.tasks.map((task: any) => task.title), ["Finished one"]);
    const open = (await client.call("search_tasks")).data;
    assert.equal(open.total, 5);
    assert.ok(!open.tasks.some((task: any) => /Example|template/.test(task.title)));
    assert.equal((await client.call("search_tasks", { limit: 2 })).data.tasks.length, 2);
    const noted = (await client.call("search_tasks", { query: "Big", include_notes: true })).data.tasks[0];
    assert.ok(noted.notes.includes("AI work log"));
    assert.equal((await client.call("search_tasks", { status: "nope" })).isError, true);
  });

  it("gives a task without an id the same id every time, without writing it", async () => {
    const { root, client } = await server();
    fill(root);
    const before = readFile(root, "Inbox/Inbox.md");
    const first = (await client.call("search_tasks", { query: "Overdue" })).data.tasks[0].id;
    const second = (await client.call("get_today")).data.overdue[0].id;
    assert.equal(first, second);
    assert.match(first, /^[0-9a-f-]{36}$/);
    assert.equal(readFile(root, "Inbox/Inbox.md"), before);
  });

  it("list_projects shows open work, and finished projects on request", async () => {
    const { root, client } = await server();
    fill(root);
    const { data } = await client.call("list_projects");
    assert.deepEqual(data.projects.map((project: any) => project.name), ["Launch"]);
    assert.equal(data.projects[0].progress, 40);
    assert.equal(data.projects[0].open_tasks, 1);
    assert.equal(data.projects[0].path, "Projects/Launch.md");
    assert.equal((await client.call("list_projects", { include_closed: true })).data.projects.length, 2);
  });
});

describe("add_task", () => {
  it("creates the inbox in the vault's language and reads back", async () => {
    const en = await server("en");
    const added = await en.client.call("add_task", { title: "Write the report", date: "2030-01-15", priority: "P2", time: "09:30", duration_minutes: 45 });
    assert.equal(added.data.task.path, "Inbox/Inbox.md");
    const line = readFile(en.root, "Inbox/Inbox.md").split("\n").find((text) => text.includes("#task"))!;
    const parsed = parseTaskLine(line, "x", 0)!;
    assert.equal(parsed.title, "Write the report");
    assert.equal(parsed.taskDate, "2030-01-15");
    assert.equal(parsed.priority, "high");
    assert.equal(parsed.startTime, "09:30");
    assert.equal(parsed.durationMinutes, 45);
    assert.equal(parsed.id, added.data.task.id);
    assert.equal(backupCount(en.root), 0, "a brand-new file has nothing to back up");

    const zh = await server("zh-TW");
    const addedZh = await zh.client.call("add_task", { title: "寫報告" });
    assert.equal(addedZh.data.task.path, "收件匣/待辦.md");
    assert.ok(readFile(zh.root, "收件匣/待辦.md").startsWith("# 待辦"));
    assert.ok(!fs.existsSync(path.join(zh.root, "Inbox")));
  });

  it("keeps BOM, CRLF and every existing byte", async () => {
    const { root, client } = await server();
    const original = `${BOM}# Inbox\r\n\r\nMy prose stays.\r\n\r\n- [ ] #task Mine 🧪 custom-token   spaced ⏳ 2030-01-01\r\n\tTab note\r\n`;
    writeFile(root, "Inbox/Inbox.md", original);
    const { data } = await client.call("add_task", { title: "New one", notes: "Line one\nLine two" });
    const after = readFile(root, "Inbox/Inbox.md");
    assert.ok(after.startsWith(original), "everything before the new task is byte for byte the same");
    assert.ok(after.endsWith("  Line one\r\n  Line two\r\n"));
    assert.ok(!/[^\r]\n/.test(after), "the added text follows the file's CRLF");
    assert.equal(after.split(BOM).length, 2);
    assert.equal(data.backup !== null, true);
    assert.equal(readFile(root, `${data.backup}/Inbox/Inbox.md`), original);
  });

  it("adds a line break when the file has no final one", async () => {
    const { root, client } = await server();
    writeFile(root, "Inbox/Inbox.md", "# Inbox\n- [ ] #task Last");
    await client.call("add_task", { title: "Next" });
    const lines = readFile(root, "Inbox/Inbox.md").split("\n");
    assert.equal(lines[1], "- [ ] #task Last");
    assert.ok(lines[2]!.startsWith("- [ ] #task Next"));
  });

  it("flattens a title so it cannot add lines or fake a marker", async () => {
    const { root, client } = await server();
    const { data } = await client.call("add_task", { title: 'Line one\n- [ ] #task Injected <!-- second-brain-task:{"id":"evil"} -->' });
    const text = readFile(root, "Inbox/Inbox.md");
    assert.equal(text.split("\n").filter((line) => line.includes("#task")).length, 1);
    assert.ok(!text.includes('"id":"evil"'));
    assert.match(data.task.id, /^[0-9a-f-]{36}$/);
  });

  it("does not take a day's P1 from the task the user chose", async () => {
    const { root, client } = await server();
    writeFile(root, "Inbox/Inbox.md", `- [ ] #task The chosen one 🔺 ⏳ ${today}\n`);
    const { data } = await client.call("add_task", { title: "Pushy", priority: "P1" });
    assert.equal(data.task.priority, "P2");
    assert.equal(data.task.date, today);
    assert.ok(data.notes[0].includes("P1"));
    assert.ok(readFile(root, "Inbox/Inbox.md").startsWith(`- [ ] #task The chosen one 🔺 ⏳ ${today}\n`));
    assert.equal((await client.call("add_task", { title: "Free day", priority: "P1", date: "2031-02-03" })).data.task.priority, "P1");
  });

  it("links to a project by its real name and warns about an unknown one", async () => {
    const { root, client } = await server();
    writeFile(root, "Projects/Launch.md", "---\ntype: project\nid: p-1\nstatus: active\n---\n# Launch\n");
    const known = await client.call("add_task", { title: "A", project: "launch" });
    assert.equal(known.data.task.project, "Launch");
    assert.equal(known.data.notes, undefined);
    assert.equal(known.data.task.path, "Inbox/Inbox.md", "tasks go to the inbox even with a project");
    const unknown = await client.call("add_task", { title: "B", project: "Nope [[x]]" });
    assert.ok(unknown.data.notes[0].includes("No project"));
    assert.ok(!readFile(root, "Inbox/Inbox.md").includes("[[Nope [[x]]"));
  });

  it("keeps writing a legacy inbox when that is the one there", async () => {
    const { root, client } = await server("zh-TW");
    writeFile(root, "10-收件匣/待辦收件匣.md", "# 舊的\n");
    assert.equal((await client.call("add_task", { title: "A" })).data.task.path, "10-收件匣/待辦收件匣.md");
  });
});

describe("complete_task", () => {
  it("ticks a task without an id, changing only its line and keeping unknown tokens", async () => {
    const { root, client } = await server();
    const lines = ["# Inbox", "", "Prose  with   spaces.", "", "- [ ] #task Keep me  🧪 custom-token ^block-1 ⏳ 2030-01-01", "    deep note", "- [ ] #task Bystander", ""];
    writeFile(root, "Inbox/Inbox.md", `${BOM}${lines.join("\r\n")}`);
    const found = (await client.call("search_tasks", { query: "Keep" })).data.tasks[0];
    const { data } = await client.call("complete_task", { id: found.id });
    assert.equal(data.task.status, "done");
    assert.equal(data.next_occurrence, null);
    const after = readFile(root, "Inbox/Inbox.md");
    assert.ok(after.startsWith(BOM));
    const afterLines = after.slice(1).split("\r\n");
    assert.equal(afterLines.length, lines.length);
    lines.forEach((line, index) => {
      if (index !== 4) assert.equal(afterLines[index], line, `line ${index}`);
    });
    const done = afterLines[4]!;
    assert.ok(done.startsWith("- [x] #task Keep me"));
    assert.ok(done.includes("🧪 custom-token"));
    assert.ok(done.includes("^block-1"));
    assert.ok(done.includes(`✅ ${today}`));
    assert.ok(done.includes(`"id":"${found.id}"`), "the id it was found by is now in the file");
    assert.ok(!afterLines[6]!.includes("second-brain-task"), "another task's line gets no id");
    // Still the same task afterwards, and doing it twice is harmless.
    assert.equal((await client.call("search_tasks", { status: "done" })).data.tasks[0].id, found.id);
    assert.equal((await client.call("complete_task", { id: found.id })).data.already_done, true);
    assert.equal(readFile(root, "Inbox/Inbox.md"), after);
  });

  it("keeps a file with mixed line endings exactly as it was", async () => {
    const { root, client } = await server();
    writeFile(root, "Inbox/Inbox.md", "# Inbox\r\nunix line\n- [ ] #task Mixed\r\nlast\n");
    const id = (await client.call("search_tasks")).data.tasks[0].id;
    await client.call("complete_task", { id });
    const after = readFile(root, "Inbox/Inbox.md");
    assert.ok(after.startsWith("# Inbox\r\nunix line\n- [x] #task Mixed"));
    assert.ok(after.endsWith("-->\r\nlast\n"));
  });

  it("finds tasks in a project file and in a file with a BOM on the first line", async () => {
    const { root, client } = await server();
    writeFile(root, "Projects/Launch.md", "---\ntype: project\nid: p-1\nstatus: active\n---\n# Launch\n\n- [ ] #task In project\n");
    writeFile(root, "Inbox/Inbox.md", `${BOM}- [ ] #task On line one\n`);
    const tasks = (await client.call("search_tasks")).data.tasks;
    for (const task of tasks) await client.call("complete_task", { id: task.id });
    assert.ok(readFile(root, "Projects/Launch.md").includes("- [x] #task In project"));
    const inbox = readFile(root, "Inbox/Inbox.md");
    assert.ok(inbox.startsWith(`${BOM}- [x] #task On line one`));
  });

  it("schedules a repeating task's next occurrence the way the desktop does", async () => {
    const { root, client } = await server();
    const body = "- [ ] #task Water plants 🔺 🔁 every week on Monday ⏳ 2020-01-06 ^chain\n\n  - [x] step one\n  - [ ] step two\n";
    writeFile(root, "Inbox/Inbox.md", `# Inbox\n\n${body}`);
    const id = (await client.call("search_tasks")).data.tasks[0].id;
    const { data } = await client.call("complete_task", { id });
    const rule = parseRecurrence("every week on Monday")!;
    // Occurrences already in the past are skipped instead of piling up.
    let expected = nextOccurrence(rule, "2020-01-06");
    while (expected < today) expected = nextOccurrence(rule, expected);
    assert.equal(data.next_occurrence.date, expected);
    assert.equal(data.next_occurrence.status, "todo");
    assert.equal(data.next_occurrence.priority, "P2", "the copy does not take a future day's P1");
    assert.equal(data.next_occurrence.title, "Water plants", "the block id stays with the original");
    const text = readFile(root, "Inbox/Inbox.md");
    const original = text.split("\n").find((line) => line.startsWith("- [x] #task Water plants"))!;
    assert.ok(original.startsWith(`- [x] #task Water plants 🔺 🔁 every week on Monday ⏳ 2020-01-06 ✅ ${today} `));
    assert.ok(original.endsWith(" ^chain"));
    const lines = text.split("\n");
    const follow = lines.findIndex((line) => line.startsWith("- [ ] #task Water plants"));
    assert.ok(follow > 0);
    assert.ok(lines[follow]!.includes(`⏳ ${expected}`));
    assert.ok(lines[follow]!.includes("🔁 every week on Monday"));
    assert.ok(lines.slice(follow).includes("  - [ ] step one"), "the checklist starts fresh");
    assert.equal(lines.filter((line) => line.includes("#task")).length, 2);
    // The new one is a real task with its own id; ticking the old one again adds nothing.
    assert.notEqual(data.next_occurrence.id, id);
    assert.equal((await client.call("complete_task", { id })).data.already_done, true);
    assert.equal(readFile(root, "Inbox/Inbox.md").split("\n").filter((line) => line.includes("#task")).length, 2);
  });

  it("does not add a second copy when the next one already exists", async () => {
    const { root, client } = await server();
    writeFile(root, "Inbox/Inbox.md", "- [ ] #task Daily 🔁 every day ⏳ 2020-01-01\n- [ ] #task Daily 🔁 every day ⏳ 2099-01-01\n");
    const tasks = (await client.call("search_tasks")).data.tasks;
    const { data } = await client.call("complete_task", { id: tasks[0].id });
    assert.equal(data.next_occurrence, null);
  });

  it("refuses when expected_sha256 is out of date, and writes nothing", async () => {
    const { root, client } = await server();
    writeFile(root, "Inbox/Inbox.md", "- [ ] #task Careful\n");
    const task = (await client.call("search_tasks")).data.tasks[0];
    writeFile(root, "Inbox/Inbox.md", "- [ ] #task Careful\nsomeone added this\n");
    const conflict = await client.call("complete_task", { id: task.id, expected_sha256: task.sha256 });
    assert.equal(conflict.isError, true);
    assert.ok(conflict.text.includes("changed"));
    assert.equal(readFile(root, "Inbox/Inbox.md"), "- [ ] #task Careful\nsomeone added this\n");
    assert.equal(backupCount(root), 0);
    const fresh = (await client.call("search_tasks")).data.tasks[0];
    assert.equal((await client.call("complete_task", { id: fresh.id, expected_sha256: fresh.sha256 })).isError, false);
  });

  it("makes a verified backup first", async () => {
    const { root, client } = await server();
    const original = "- [ ] #task Back me up\n";
    writeFile(root, "Inbox/Inbox.md", original);
    const id = (await client.call("search_tasks")).data.tasks[0].id;
    const { data } = await client.call("complete_task", { id });
    assert.equal(readFile(root, `${data.backup}/Inbox/Inbox.md`), original);
    assert.ok(fs.existsSync(path.join(root, ...data.backup.split("/"), "manifest.json")));
  });
});

describe("add_work_log", () => {
  it("writes under the task in the existing format, as the parser and hook expect", async () => {
    const { root, client } = await server();
    writeFile(root, "Inbox/Inbox.md", "# Inbox\n\n- [ ] #task First\n\n  An existing note.\n\n- [ ] #task Second\n\nTrailing prose.\n");
    const first = (await client.call("search_tasks", { query: "First" })).data.tasks[0];
    const { data } = await client.call("add_work_log", { tool: "Claude Code", task_id: first.id, done: "Wrote it", result: "docs/x.md", next: "Review\nit" });
    assert.match(data.heading, /^### AI work log \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Claude Code\)$/);
    const text = readFile(root, "Inbox/Inbox.md");
    const expected = [
      "# Inbox", "", "- [ ] #task First", "", "  An existing note.", "",
      `  ${data.heading}`, "", "  - Done: Wrote it", "  - Result: docs/x.md", "  - Next: Review it", "",
      "- [ ] #task Second", "", "Trailing prose.", "",
    ].join("\n");
    assert.equal(text, expected);
    const notes = (await client.call("search_tasks", { query: "First", include_notes: true })).data.tasks[0];
    assert.equal(notes.id, first.id, "the task line was not touched");
    const log = parseAiWorklog(notes.notes);
    assert.equal(log[0]!.tool, "Claude Code");
    assert.equal(log[0]!.next, "Review it");
    assert.equal((await client.call("get_today")).data.recent_handoffs[0].next, "Review it");
  });

  it("uses the Chinese format in a Chinese vault, and keeps BOM and CRLF", async () => {
    const { root, client } = await server("zh-TW");
    const original = `${BOM}# 待辦\r\n\r\n- [ ] #task 整理重點\r\n`;
    writeFile(root, "收件匣/待辦.md", original);
    const task = (await client.call("search_tasks")).data.tasks[0];
    const { data } = await client.call("add_work_log", { tool: "Codex", task_id: task.id, done: "做完了", next: "追蹤" });
    assert.match(data.heading, /^### AI 工作紀錄 \d{4}-\d{2}-\d{2} \d{2}:\d{2}（Codex）$/);
    const after = readFile(root, "收件匣/待辦.md");
    assert.equal(after, `${original}\r\n  ${data.heading}\r\n\r\n  - 做了什麼：做完了\r\n  - 下一步：追蹤\r\n`);
    assert.equal(readFile(root, `${data.backup}/收件匣/待辦.md`), original);
  });

  it("keeps a missing final line break missing", async () => {
    const { root, client } = await server();
    writeFile(root, "Inbox/Inbox.md", "- [ ] #task Last");
    const task = (await client.call("search_tasks")).data.tasks[0];
    const { data } = await client.call("add_work_log", { tool: "T", task_id: task.id, done: "x" });
    assert.equal(readFile(root, "Inbox/Inbox.md"), `- [ ] #task Last\n\n  ${data.heading}\n\n  - Done: x`);
  });

  it("writes to .ai/worklog when no task matches, and appends after that", async () => {
    const { root, client } = await server();
    const first = await client.call("add_work_log", { tool: "Gemini (CLI)", title: "Looked at logs", done: "Read them", next: "Nothing" });
    const month = today.slice(0, 7);
    assert.equal(first.data.path, `.ai/worklog/${month}.md`);
    assert.match(first.data.heading, /\(Gemini CLI\) Looked at logs$/);
    const second = await client.call("add_work_log", { tool: "Codex", title: "More", done: "Again" });
    const text = readFile(root, `.ai/worklog/${month}.md`);
    assert.equal(text, `${first.data.heading}\n\n- Done: Read them\n- Next: Nothing\n\n${second.data.heading}\n\n- Done: Again\n`);
    assert.equal(parseAiWorklog(text).length, 2);
    assert.equal(first.data.backup, null);
    assert.notEqual(second.data.backup, null);
  });

  it("satisfies the stop hook, which then lets the turn end", async () => {
    const { root, env, client } = await server();
    writeFile(root, "Inbox/Inbox.md", "- [ ] #task Work\n");
    const session = JSON.stringify({ session_id: "mcp-1", cwd: root });
    const script = path.join(root, ".ai", "bin", "aizbrain-hook.mjs");
    fs.mkdirSync(path.dirname(script), { recursive: true });
    const { hook } = await builtBundles();
    fs.copyFileSync(hook, script);
    assert.equal(runNode(script, ["--aizbrain-hook", "session-start"], { env, input: session }).status, 0);
    const started = new Date(Date.now() + 2000);
    const task = (await client.call("search_tasks")).data.tasks[0];
    await client.call("add_work_log", { tool: "T", task_id: task.id, done: "x" });
    fs.utimesSync(path.join(root, "Inbox", "Inbox.md"), started, started);
    assert.equal(runNode(script, ["--aizbrain-hook", "stop"], { env, input: session }).status, 0);
  });

  it("refuses when expected_sha256 is out of date", async () => {
    const { root, client } = await server();
    writeFile(root, "Inbox/Inbox.md", "- [ ] #task Careful\n");
    const task = (await client.call("search_tasks")).data.tasks[0];
    const conflict = await client.call("add_work_log", { tool: "T", task_id: task.id, done: "x", expected_sha256: "0".repeat(64) });
    assert.equal(conflict.isError, true);
    assert.equal(readFile(root, "Inbox/Inbox.md"), "- [ ] #task Careful\n");
  });
});

describe("links and hidden folders", () => {
  function linkOrSkip(t: { skip: (message: string) => void }, target: string, link: string): boolean {
    try {
      fs.symlinkSync(target, link, "junction");
      return true;
    } catch {
      t.skip("cannot create links here");
      return false;
    }
  }

  it("add_task refuses an inbox folder that is a link", async (t) => {
    const { root, client } = await server();
    const outside = tempDir();
    if (!linkOrSkip(t, outside, path.join(root, "Inbox"))) return;
    const result = await client.call("add_task", { title: "Escape" });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes("unsafe"));
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  it("add_work_log refuses a worklog folder that is a link", async (t) => {
    const { root, client } = await server();
    const outside = tempDir();
    if (!linkOrSkip(t, outside, path.join(root, ".ai", "worklog"))) return;
    assert.equal((await client.call("add_work_log", { tool: "T", done: "x" })).isError, true);
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  it("never reads or lists tasks through a link", async (t) => {
    const { root, client } = await server();
    const outside = tempDir();
    writeFile(outside, "secret.md", "- [ ] #task Outside the vault\n");
    if (!linkOrSkip(t, outside, path.join(root, "linked"))) return;
    assert.equal((await client.call("search_tasks")).data.total, 0);
    assert.equal(readFile(outside, "secret.md"), "- [ ] #task Outside the vault\n");
  });

  it("does not list tasks in hidden or technical folders", async () => {
    const { root, client } = await server();
    writeFile(root, ".obsidian/x.md", "- [ ] #task Hidden\n");
    writeFile(root, "node_modules/a/README.md", "- [ ] #task Technical\n");
    writeFile(root, ".ai/worklog/2026-10.md", "- [ ] #task In a log\n");
    assert.equal((await client.call("search_tasks")).data.total, 0);
  });
});
