(() => {
  const cfg = JSON.parse(document.getElementById("aiz-config").textContent);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const params = new URLSearchParams(location.search);
  const recording = params.has("record");
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  // Copy buttons
  $$("[data-copy]").forEach((button) => {
    const label = button.textContent;
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        button.textContent = button.dataset.done;
        setTimeout(() => { button.textContent = label; }, 1600);
      } catch { /* the command stays visible to select by hand */ }
    });
  });

  // Reveal on scroll
  const reveals = $$(".reveal");
  if (reduced || !("IntersectionObserver" in window)) {
    reveals.forEach((el) => el.classList.add("in"));
  } else {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) { entry.target.classList.add("in"); observer.unobserve(entry.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    reveals.forEach((el) => observer.observe(el));
  }

  // Product tabs
  const shotImg = $("[data-shot-img]");
  const shotCap = $("[data-shot-cap]");
  const tabs = $$("[data-shot]");
  tabs.forEach((tab) => tab.addEventListener("click", () => {
    tabs.forEach((other) => other.setAttribute("aria-selected", String(other === tab)));
    shotImg.src = `/assets/screens/${tab.dataset.shot}-${cfg.lang}.webp`;
    shotCap.textContent = tab.dataset.cap;
  }));
  tabs.forEach((tab) => { new Image().src = `/assets/screens/${tab.dataset.shot}-${cfg.lang}.webp`; });

  // Direct download links from the latest release; the release page stays the fallback.
  const isMac = /Mac/i.test(navigator.platform) || /Macintosh/i.test(navigator.userAgent);
  const primary = $("[data-download]");
  primary.textContent = isMac ? cfg.dlMac : cfg.dlWin;
  fetch(`https://api.github.com/repos/${cfg.repoSlug}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } })
    .then((response) => (response.ok ? response.json() : null))
    .then((release) => {
      if (!release) return;
      const find = (suffix) => release.assets.find((asset) => asset.name.endsWith(suffix))?.browser_download_url;
      const win = find("_x64-setup.exe");
      const mac = find("_universal.dmg");
      const pick = isMac ? mac : win;
      if (pick) primary.href = pick;
      $$('[data-dl="win"]').forEach((link) => { if (win) link.href = win; });
      $$('[data-dl="mac"]').forEach((link) => { if (mac) link.href = mac; });
      const note = $("[data-version-note]");
      if (note) note.textContent = cfg.versionNote.replace("{version}", release.tag_name);
    })
    .catch(() => {});

  // Relay demo: a replay of a recorded session, see tools/relay/
  const demo = cfg.demo;
  const bar = $("[data-relay]");
  const term = $("[data-term]");
  const file = $("[data-file]");
  const termTitle = $("[data-term-title]");
  demo.steps.forEach((step, index) => {
    if (index) bar.insertAdjacentHTML("beforeend", '<span class="relay-arrow">→</span>');
    const chip = document.createElement("span");
    chip.className = "relay-step";
    chip.innerHTML = "<i></i>";
    chip.append(step.tool);
    bar.append(chip);
  });
  const replay = document.createElement("button");
  replay.type = "button";
  replay.className = "demo-replay";
  replay.textContent = cfg.replay;
  bar.append(replay);
  const chips = $$(".relay-step", bar);

  const renderFileHead = () => {
    file.replaceChildren();
    demo.file.forEach(([kind, text]) => addFile(kind, text, false));
  };
  const addFile = (kind, text, fresh) => {
    const line = document.createElement("span");
    line.className = `${kind}${fresh ? " fresh" : ""}`;
    line.style.display = "block";
    line.style.whiteSpace = "pre-wrap";
    line.textContent = text || " ";
    file.append(line);
    file.scrollTop = file.scrollHeight;
  };
  const addLine = (kind, text, gap) => {
    const line = document.createElement("div");
    line.className = `line ${kind}${gap ? " gap" : ""}`;
    line.textContent = text;
    term.append(line);
    term.parentElement.scrollTop = term.parentElement.scrollHeight;
    return line;
  };

  let token = 0;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const run = async () => {
    const mine = ++token;
    const alive = () => mine === token;
    while (alive()) {
      term.replaceChildren();
      renderFileHead();
      chips.forEach((chip) => { chip.className = "relay-step"; });
      for (let i = 0; i < demo.steps.length && alive(); i += 1) {
        const step = demo.steps[i];
        chips[i].className = "relay-step on";
        termTitle.textContent = step.title;
        term.replaceChildren();
        for (const entry of step.lines) {
          if (!alive()) return;
          if (entry.k === "you") {
            const line = addLine("you cursor", "", false);
            for (let c = 1; c <= entry.t.length && alive(); c += 1) {
              line.textContent = entry.t.slice(0, c);
              await wait(cfg.lang === "en" ? 24 : 58);
            }
            line.classList.remove("cursor");
            await wait(380);
          } else if (entry.k === "file") {
            entry.t.forEach(([kind, text]) => addFile(kind, text, true));
            await wait(entry.w ?? 1000);
          } else {
            addLine(entry.k, entry.t, entry.gap);
            await wait(entry.w ?? 900);
          }
        }
        if (!alive()) return;
        chips[i].className = step.fail ? "relay-step" : "relay-step done";
        await wait(step.hold ?? 1300);
      }
      if (recording) { window.__demoDone = true; return; }
      await wait(3600);
    }
  };

  replay.addEventListener("click", () => { run(); });
  if (reduced) {
    // No animation: show the finished relay.
    const last = demo.steps[demo.steps.length - 1];
    termTitle.textContent = last.title;
    renderFileHead();
    demo.steps.forEach((step) => step.lines.forEach((entry) => {
      if (entry.k === "file") entry.t.forEach(([kind, text]) => addFile(kind, text, false));
    }));
    last.lines.filter((entry) => entry.k !== "file").forEach((entry) => addLine(entry.k, entry.t, entry.gap));
    chips.forEach((chip) => { chip.className = "relay-step done"; });
  } else {
    const start = () => { run(); };
    if (recording || !("IntersectionObserver" in window)) start();
    else {
      const seen = new IntersectionObserver((entries, self) => {
        if (entries.some((entry) => entry.isIntersecting)) { self.disconnect(); start(); }
      }, { threshold: 0.25 });
      seen.observe($("#demo"));
    }
  }
})();
