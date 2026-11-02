# -*- coding: utf-8 -*-
"""Build the static site into apps/website/public. Standard library plus Pillow.

    python apps/website/tools/build.py
"""
import html
import json
import re
import shutil
from pathlib import Path

from PIL import Image

from strings import STRINGS

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
OUT = ROOT / "public"
SCREENS = ROOT / "assets" / "screens"
LOGO = ROOT.parents[0] / "desktop" / "src" / "assets" / "app-logo.png"
REPO_SLUG = "GsirGinRay/aizbrain"


def page(lang, strings):
    template = (SRC / "template.html").read_text("utf-8")
    demo = json.loads((ROOT / "tools" / "relay" / f"demo-{lang}.json").read_text("utf-8"))
    runtime = {
        "lang": lang,
        "repoSlug": REPO_SLUG,
        "dlWin": strings["dl_win"],
        "dlMac": strings["dl_mac"],
        "versionNote": strings["version_note"],
        "replay": strings["replay"],
        "demo": demo,
    }
    values = dict(strings)
    values["repo"] = f"https://github.com/{REPO_SLUG}"
    values["releases"] = f"https://github.com/{REPO_SLUG}/releases/latest"
    values["runtime"] = json.dumps(runtime, ensure_ascii=False).replace("</", "<\\/")
    rendered = re.sub(r"\{\{(\w+)\}\}", lambda m: values[m.group(1)], template)
    leftovers = re.findall(r"\{\{\w+\}\}", rendered)
    assert not leftovers, leftovers
    return rendered


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    assets = OUT / "assets"
    (assets / "screens").mkdir(parents=True)
    shutil.copy(SRC / "styles.css", assets / "styles.css")
    shutil.copy(SRC / "app.js", assets / "app.js")
    for name in ("og-en.png", "og-zh-TW.png", "relay-en.gif", "relay-zh-TW.gif"):
        source = ROOT / "assets" / name
        if source.exists():
            shutil.copy(source, assets / name)
    Image.open(LOGO).convert("RGBA").resize((64, 64), Image.LANCZOS).save(assets / "logo-64.png", optimize=True)
    for lang in ("en", "zh-TW"):
        for shot in ("today", "calendar", "board", "projects"):
            source = SCREENS / f"{shot}-{lang}-dark.png"
            Image.open(source).convert("RGB").resize((1360, 850), Image.LANCZOS).save(
                assets / "screens" / f"{shot}-{lang}.webp", quality=84, method=6)
    (OUT / "index.html").write_text(page("en", STRINGS["en"]), "utf-8")
    (OUT / "zh-TW").mkdir()
    (OUT / "zh-TW" / "index.html").write_text(page("zh-TW", STRINGS["zh-TW"]), "utf-8")
    (OUT / "robots.txt").write_text("User-agent: *\nAllow: /\nSitemap: https://aizbrain.com/sitemap.xml\n", "utf-8")
    (OUT / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
        "<url><loc>https://aizbrain.com/</loc></url><url><loc>https://aizbrain.com/zh-TW/</loc></url></urlset>\n", "utf-8")
    total = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(f"built {OUT} ({total / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
