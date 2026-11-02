# -*- coding: utf-8 -*-
"""Render the hero replay to video and GIF, and the social cards, from the built site.

    python -m http.server 8391 --directory apps/website/public
    python apps/website/tools/media.py [--video] [--cards]
"""
import argparse
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:8391"
ASSETS = ROOT / "assets"

ISOLATE = """
html,body{background:#060a13!important;overflow:hidden!important}
.nav,.hero-head,section,footer,.skip,.demo-cap{display:none!important}
.hero{padding:0!important}.hero::before{display:none!important}
.hero>.wrap{width:100%!important}
.demo{margin:0!important;border-radius:0!important;border:0!important;box-shadow:none!important}
.demo-replay{display:none!important}
"""

CARD = """<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0}
body{width:1200px;height:630px;background:#060a13;color:#edf2fb;font-family:'Segoe UI Variable Text','Segoe UI','Microsoft JhengHei',sans-serif;position:relative;overflow:hidden;padding:64px 72px}
body:before{content:"";position:absolute;inset:0;background:radial-gradient(700px 380px at 30% 0,rgba(70,130,255,.28),transparent 70%),radial-gradient(500px 300px at 92% 90%,rgba(246,196,83,.14),transparent 70%)}
.b{position:relative;display:flex;align-items:center;gap:16px;font-size:34px;font-weight:700}.b img{width:58px;height:58px;border-radius:13px}.b i{font-style:normal;color:#5aa5ff}
h1{position:relative;font-size:SIZE;line-height:1.08;letter-spacing:-.03em;margin:54px 0 28px;font-weight:800}h1 em{font-style:normal;color:#f6c453}
p{position:relative;font-size:29px;color:#b9c5dc;margin:0}
.r{position:absolute;left:72px;bottom:58px;display:flex;gap:12px;font-size:21px;font-weight:600;color:#9aa8c2;align-items:center}.r span{border:1px solid #30415f;border-radius:10px;padding:8px 15px}.r span.on{background:#f6c453;color:#17120a;border-color:#f6c453}
</style><div class="b"><img src="LOGO"><span>BRAND</span></div><h1>HEADLINE</h1><p>SUB</p><div class="r"><span>Claude</span>→<span class="on">Codex</span>→<span>Gemini</span>→<span>NEXT</span></div>"""


def video(play, path, name, width, height, zoom=1.0):
    with tempfile.TemporaryDirectory() as temp:
        browser = play.chromium.launch(channel="chrome")
        context = browser.new_context(viewport={"width": width, "height": height}, record_video_dir=temp, record_video_size={"width": width, "height": height})
        page = context.new_page()
        page.goto(f"{BASE}{path}?record=1")
        page.add_style_tag(content=ISOLATE + f"body{{zoom:{zoom}}}.term,.file{{height:{int(height / zoom) - 52}px!important}}")
        page.wait_for_function("window.__demoDone === true", timeout=120000)
        page.wait_for_timeout(1800)
        recorded = page.video.path()
        context.close()
        browser.close()
        mp4 = ASSETS / f"{name}.mp4"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "0.6", "-i", str(recorded), "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", str(mp4)], check=True)
    return mp4


def gif(mp4, out, width=960, fps=12):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(mp4), "-filter_complex",
                    f"fps={fps},scale={width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none", str(out)], check=True)


def cards(play):
    logo = (ROOT.parents[0] / "desktop/src/assets/app-logo.png").as_uri()
    copy = {
        "en": dict(BRAND="<i>AI</i>zBrain", SIZE="74px", HEADLINE="Models change.<br><em>Your workflow doesn’t.</em>", SUB="The free, local second brain every AI shares.", NEXT="next"),
        "zh-TW": dict(BRAND="第二大腦 <i>AI</i>zBrain", SIZE="78px", HEADLINE="AI 模型可以換，<br><em>工作流程不能換。</em>", SUB="免費開源，換哪一家 AI 都接得上。", NEXT="下一家"),
    }
    browser = play.chromium.launch(channel="chrome")
    for lang, values in copy.items():
        html = CARD.replace("LOGO", logo)
        for key, value in values.items():
            html = html.replace(key, value)
        page = browser.new_page(viewport={"width": 1200, "height": 630})
        with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8") as handle:
            handle.write(html)
        page.goto(Path(handle.name).as_uri())
        page.wait_for_timeout(300)
        page.screenshot(path=str(ASSETS / f"og-{lang}.png"))
        page.close()
        Path(handle.name).unlink()
    browser.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", action="store_true")
    parser.add_argument("--cards", action="store_true")
    args = parser.parse_args()
    with sync_playwright() as play:
        if args.cards or not args.video:
            cards(play)
        if args.video or not args.cards:
            gif(video(play, "/", "relay-en", 1200, 520), ASSETS / "relay-en.gif")
            gif(video(play, "/zh-TW/", "relay-zh-TW", 1200, 520), ASSETS / "relay-zh-TW.gif")
            video(play, "/zh-TW/", "relay-zh-TW-1080p", 1920, 1080, 1.6)


if __name__ == "__main__":
    main()
