# aizbrain.com

Static product site in English (`/`) and Traditional Chinese (`/zh-TW/`). No cookies, no analytics.

| Path | Purpose |
| --- | --- |
| `src/` | Page template, styles and script |
| `tools/strings.py` | All copy. Keep every claim true of the shipped product |
| `tools/relay/` | The hero replay, transcribed from a recorded session |
| `tools/capture.py` | Screenshots of the real desktop UI against the synthetic vault in `tools/demo_vault.py`, using an in-memory backend |
| `tools/media.py` | Renders the replay to mp4 and GIF, and the social cards |
| `tools/build.py` | Writes `public/`, which is committed and is what ships |
| `Dockerfile`, `Caddyfile` | The container served behind the host's Caddy |

```bash
npm --workspace @second-brain/desktop run dev -- --port 5174
python apps/website/tools/capture.py
python apps/website/tools/build.py
python -m http.server 8391 --directory apps/website/public
```

Needs Python with Pillow and Playwright, Chrome, and ffmpeg for `media.py`.
