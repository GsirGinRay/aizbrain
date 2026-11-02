# -*- coding: utf-8 -*-
"""Synthetic demo vaults for the website screenshots. All names here are made up."""
import datetime as dt
import json
import uuid

MARKER = "second-brain-task"


def _id(seed):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "aizbrain-demo/" + seed))


def _task(title, project=None, *, day=None, time=None, mins=None, prio=None, status="todo",
          rank=1, repeat=None, done=None, body=None, seed=None):
    box = "x" if status == "done" else " "
    parts = [f"- [{box}] #task {title}"]
    if project:
        parts.append(f"[[{project}]]")
    if prio:
        parts.append({"highest": "\U0001F53A", "high": "⏫", "medium": "\U0001F53C", "low": "\U0001F53D"}[prio])
    if repeat:
        parts.append("\U0001F501 " + repeat)
    if day:
        parts.append("⏳ " + day)
    if time:
        parts.append("⏰ " + time)
        parts.append(f"⏱ {mins or 30}m")
    elif mins:
        parts.append(f"⏱ {mins}m")
    if done:
        parts.append("✅ " + done)
    marker = {"id": _id(seed or title), "status": status, "rank": f"{rank:08d}"}
    if time:
        marker.update(startTime=time, durationMinutes=mins or 30, timeZone="Asia/Taipei")
    parts.append(f"<!-- {MARKER}:{json.dumps(marker, ensure_ascii=False)} -->")
    line = " ".join(parts)
    if body:
        line += "\n\n" + "\n".join(("  " + b) if b else "" for b in body.split("\n")) + "\n"
    return line


def _project(name, status, progress, start, end, seed, prio=1):
    return (f"---\ntype: project\nid: {_id('project/' + seed)}\nstatus: {status}\npriority: {prio}\n"
            f"progress: {progress}\nstart_date: {start}\nend_date: {end}\n---\n\n# {name}\n\n")


def _collection(title, category):
    return f"---\ntype: knowledge\ncategory: {category}\n---\n\n# {title}\n\n"


def english_vault(today):
    d = lambda n: (today + dt.timedelta(days=n)).isoformat()
    log = (
        "### AI work log {day} 21:14 (Claude Code)\n"
        "- Done: wrote the launch post draft and the three screenshots brief\n"
        "- Result: Knowledge/Launch post.md\n"
        "- Next: Codex tightens the install steps, then a final read\n"
    ).format(day=d(-1))
    launch = "Launch"
    files = {
        "Inbox/Inbox.md": "# Inbox\n\n" + "\n".join([
            _task("Try the phone share menu on the train", prio=None, rank=11),
            _task("Idea: a weekly digest of AI handoffs", rank=12),
            _task("Compare two invoice templates", rank=13),
            _task("Ask Maya for the logo files", status="waiting", day=d(1), rank=14),
        ]) + "\n",
        "Projects/Launch.md": _project("Launch", "active", 68, d(-20), d(12), "launch", 1) + "\n".join([
            _task("Finish the launch post with the next AI", launch, day=d(0), time="09:30", mins=60, prio="highest", rank=1, body=log),
            _task("Record the 20-second demo", launch, day=d(0), time="11:00", mins=45, prio="high", rank=2),
            _task("Review the landing page copy", launch, day=d(0), time="14:00", mins=30, prio="medium", rank=3),
            _task("Reply to beta testers", launch, day=d(0), mins=20, rank=4),
            _task("Publish release notes", launch, day=d(2), time="10:00", mins=30, rank=5),
            _task("Submit to the newsletter", launch, day=d(3), mins=30, prio="medium", rank=6),
            _task("Draft the launch thread", launch, status="doing", day=d(1), mins=40, rank=7),
            _task("Write the FAQ", launch, status="done", day=d(-2), done=d(-2), rank=8),
            _task("Choose the launch date", launch, status="done", day=d(-3), done=d(-3), rank=9),
            _task("Wait for legal to approve the terms", launch, status="waiting", day=d(2), rank=10),
        ]) + "\n",
        "Projects/Client Portal.md": _project("Client Portal", "active", 42, d(-30), d(30), "portal", 2) + "\n".join([
            _task("Send the sprint summary", "Client Portal", day=d(0), time="16:00", mins=30, rank=20),
            _task("Weekly client call", "Client Portal", day=d(1), time="15:00", mins=45, repeat="every week on Tuesday", rank=21),
            _task("Fix the invoice export", "Client Portal", status="doing", day=d(1), mins=90, prio="high", rank=22),
            _task("Design the billing page", "Client Portal", day=d(4), mins=120, rank=23),
            _task("Migrate the old accounts", "Client Portal", day=d(5), mins=90, prio="medium", rank=24),
            _task("Set up the staging server", "Client Portal", status="done", day=d(-1), done=d(-1), rank=25),
        ]) + "\n",
        "Projects/Personal.md": _project("Personal", "active", 25, d(-10), d(60), "personal", 3) + "\n".join([
            _task("Morning run", "Personal", day=d(0), time="07:30", mins=30, repeat="every day", rank=30),
            _task("Book the dentist", "Personal", day=d(3), rank=31),
            _task("Pay the phone bill", "Personal", day=d(6), repeat="every month on the 8th", rank=32),
            _task("Plan the weekend trip", "Personal", day=d(9), mins=60, rank=33),
        ]) + "\n",
        "Projects/Course Notes.md": _project("Course Notes", "planning", 10, d(5), d(70), "course", 4) + "\n".join([
            _task("Outline module one", "Course Notes", day=d(7), mins=60, rank=40),
            _task("Pick the sample project", "Course Notes", day=d(10), rank=41),
        ]) + "\n",
        "Knowledge/Prompts/Weekly review prompt.md": _collection("Weekly review prompt", "Prompts") + "Summarize what moved this week for [project].\n",
        "Knowledge/Launch post.md": _collection("Launch post", "Notes") + "Models change. Your workflow doesn't.\n",
    }
    return files


def chinese_vault(today):
    d = lambda n: (today + dt.timedelta(days=n)).isoformat()
    log = (
        "### AI 工作紀錄 {day} 21:14（Antigravity）\n"
        "- 做了什麼：照三個條件搜尋資料，寫進這則筆記\n"
        "- 結果在哪：知識/營收觀察名單資料.md\n"
        "- 下一步：換 Codex 把名單做成一張圖\n"
    ).format(day=d(-1))
    stock = "台股選股"
    files = {
        "收件匣/待辦.md": "# 待辦收件匣\n\n" + "\n".join([
            _task("近一個月漲幅太高的要排除", rank=11),
            _task("試試手機分享選單", rank=12),
            _task("整理這季的扣繳憑單", rank=13),
            _task("等營業員寄產業報告", status="waiting", day=d(1), rank=14),
        ]) + "\n",
        "專案/台股選股.md": _project(stock, "active", 68, d(-20), d(12), "stock", 1) + "\n".join([
            _task("跑營收觀察名單", stock, day=d(0), time="21:00", mins=60, prio="highest", rank=1, repeat="every month on the 10th", body=log),
            _task("把持股營收逐檔對一遍", stock, day=d(0), time="09:00", mins=60, prio="high", rank=2),
            _task("看盤前功課", stock, day=d(0), time="08:30", mins=20, rank=3),
            _task("讀法說會逐字稿", stock, day=d(0), mins=40, prio="medium", rank=4),
            _task("更新選股條件筆記", stock, day=d(2), mins=30, rank=5),
            _task("把三個條件拿去回測", stock, status="doing", day=d(1), mins=60, rank=6),
            _task("整理上個月的名單", stock, status="done", day=d(-2), done=d(-2), rank=7),
            _task("設定營收日提醒", stock, status="done", day=d(-3), done=d(-3), rank=8),
        ]) + "\n",
        "專案/工作專案.md": _project("工作專案", "active", 42, d(-30), d(30), "work", 2) + "\n".join([
            _task("整理這週財報", "工作專案", day=d(0), time="14:00", mins=90, rank=20),
            _task("週會", "工作專案", day=d(1), time="10:00", mins=45, repeat="every week on Tuesday", rank=21),
            _task("交部門月報", "工作專案", status="doing", day=d(1), mins=60, prio="high", rank=22),
            _task("準備季度簡報", "工作專案", day=d(4), mins=120, rank=23),
            _task("確認供應商報價", "工作專案", status="waiting", day=d(2), rank=24),
        ]) + "\n",
        "專案/生活.md": _project("生活", "active", 25, d(-10), d(60), "life", 3) + "\n".join([
            _task("繳電話費", "生活", day=d(6), repeat="every month on the 8th", rank=30),
            _task("預約牙醫", "生活", day=d(3), rank=31),
            _task("週末家庭旅遊規劃", "生活", day=d(9), mins=60, rank=32),
        ]) + "\n",
        "知識/提示詞/營收選股提示詞.md": _collection("營收選股提示詞", "提示詞") + "請幫我整理 [月份] 的營收觀察名單。\n",
        "知識/選股條件.md": _collection("選股條件", "方法") + "營收創新高、外資連續買超、近一個月漲幅不要太高。\n",
    }
    return files
