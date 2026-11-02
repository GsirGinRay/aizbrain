# -*- coding: utf-8 -*-
"""Screenshot the real desktop UI against a synthetic vault.

Runs the actual React app from apps/desktop in Chromium with an in-memory stand-in
for the Tauri backend, so nothing touches an installed app or a real vault.

    npm --workspace @second-brain/desktop run dev   # serves http://localhost:5174
    python apps/website/tools/capture.py [--out DIR] [--only today]
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

from demo_vault import chinese_vault, english_vault

ROOT = Path(__file__).resolve().parents[1]
URL = "http://localhost:5174/"
SIZE = {"width": 1360, "height": 850}
LAST_SEEN_KEY = re.search(r'LAST_SEEN_VERSION_KEY = "([^"]+)"', (ROOT.parents[0] / "desktop/src/whats-new.tsx").read_text("utf-8")).group(1)
VERSION = json.loads((ROOT.parents[1] / "package.json").read_text("utf-8"))["version"]

STUB = r"""
(() => {
  const vault = __VAULT__;
  const files = new Map(Object.entries(vault));
  const utf8 = (text) => new TextEncoder().encode(text);
  const b64 = (bytes) => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
  const sha = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
  const handlers = {
    diagnostics: () => ({ selectedVault: "C:/Demo/My Second Brain", watcherStatus: "watching", keyFingerprint: "demo", keyBackend: "demo", recoveryStatus: "ok", closeBehavior: "exit", autostartEnabled: false }),
    select_vault: () => ({ vaultId: "demo", root: "C:/Demo/My Second Brain" }),
    load_routine_template: () => null,
    save_routine_template: () => null,
    scan_vault: async () => {
      const out = [];
      for (const [relativePath, text] of files) {
        if (relativePath.startsWith(".ai/") || !relativePath.includes("/")) continue;
        const bytes = utf8(text);
        out.push({ relativePath, sha256: await sha(bytes), bytes: bytes.length, hasBom: false, newline: "lf" });
      }
      return { files: out, totalBytes: out.reduce((n, f) => n + f.bytes, 0) };
    },
    read_markdown_files: async ({ request }) => {
      const out = [];
      for (const relativePath of request.relativePaths) {
        if (!files.has(relativePath)) continue;
        const bytes = utf8(files.get(relativePath));
        out.push({ relativePath, sha256: await sha(bytes), bytesBase64: b64(bytes) });
      }
      return { files: out };
    },
    apply_markdown_changes: ({ changes }) => {
      for (const c of changes) {
        if (c.operation === "delete") files.delete(c.relativePath);
        else files.set(c.relativePath, new TextDecoder().decode(Uint8Array.from(atob(c.replacementBase64), (x) => x.charCodeAt(0))));
      }
      return { journalPath: "demo", backupPath: "demo" };
    },
    list_managed_files: () => [],
    check_app_update: () => ({ currentVersion: "0.9.4", latestVersion: "0.9.4", available: false, checked: true, notes: null }),
    inbox_relay_status: () => { throw new Error("demo"); },
  };
  window.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => { const id = Math.floor(Math.random() * 1e9); window["_" + id] = cb; return id; },
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    invoke: async (cmd, args) => {
      if (handlers[cmd]) return handlers[cmd](args || {});
      return null;
    },
  };
  localStorage.setItem("second-brain.onboardingCompleted", "true");
  localStorage.setItem("__LASTSEEN__", "__VERSION__");
  localStorage.setItem("second-brain.uiPreferences", JSON.stringify(__PREFS__));
})();
"""

SHOTS = [
    ("today", "today"),
    ("calendar", "calendar"),
    ("board", "board"),
    ("projects", "projects"),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(ROOT / "assets" / "screens"))
    parser.add_argument("--only")
    args = parser.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    today = dt.date.today()
    vaults = {"en": english_vault(today), "zh-TW": chinese_vault(today)}
    with sync_playwright() as play:
        browser = play.chromium.launch(channel="chrome")
        for language, vault in vaults.items():
            for theme in ("dark", "light"):
                prefs = {"language": language, "theme": theme, "density": "comfortable", "detailSurface": "dialog"}
                context = browser.new_context(viewport=SIZE, device_scale_factor=2, locale=language)
                context.add_init_script(STUB.replace("__VAULT__", json.dumps(vault, ensure_ascii=False)).replace("__PREFS__", json.dumps(prefs)).replace("__LASTSEEN__", LAST_SEEN_KEY).replace("__VERSION__", VERSION))
                page = context.new_page()
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(URL)
                page.wait_for_timeout(2500)
                buttons = page.locator(".sidebar nav button")
                count = buttons.count()
                labels = [buttons.nth(i).get_attribute("aria-label") for i in range(count)]
                print(language, theme, "nav:", labels, "errors:", [e for e in errors if "unregisterListener" not in e][:2])
                order = {"today": 0, "calendar": 1, "board": 2, "projects": 3}
                for name, _ in SHOTS:
                    if args.only and args.only != name:
                        continue
                    buttons.nth(order[name]).click()
                    page.wait_for_timeout(900)
                    target = out / f"{name}-{language}-{theme}.png"
                    page.screenshot(path=str(target))
                    print("  wrote", target.name)
                context.close()
        browser.close()


if __name__ == "__main__":
    main()
