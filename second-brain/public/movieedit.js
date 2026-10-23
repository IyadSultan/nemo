/**
 * The movie panel. It sits where the transcript sits.
 * Say Hey, then one of the orders in the list. The same list is in the app manual.
 *
 * The preview plays the edited movie, not the raw file: it jumps from clip to
 * clip, uses the movie speed and volume, and draws the captions and fades on top.
 * The buttons under the preview send the same sentences you could say.
 */
(function () {
  const btn = document.getElementById("movieBtn");
  const mv = {
    root: null,
    busy: false,
    project: null,
    segs: [],
    total: 0,
    t: 0,
    cur: -1,
    playing: false,
    loadedPath: "",
    loadToken: 0,
    selected: -1,
    frame: 0,
  };

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, title, onClick, cls = "ghost-btn") {
    const node = el("button", cls, label);
    node.type = "button";
    if (title) node.title = title;
    node.addEventListener("click", onClick);
    return node;
  }

  function choice(title, pairs, onChange) {
    const node = document.createElement("select");
    node.className = "movie-select";
    node.title = title;
    for (const [value, label] of pairs) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      node.append(option);
    }
    node.addEventListener("change", () => onChange(node.value));
    return node;
  }

  /** A row of buttons under one small label. */
  function group(label, ...nodes) {
    const box = el("div", "movie-group");
    box.append(el("span", "movie-group-label", label), ...nodes);
    return box;
  }

  /** Sends an order about the picked clip. */
  function clipHear(phrase) {
    if (mv.selected < 0) return;
    hear(phrase.replace(/\bclip N\b/g, `clip ${mv.selected + 1}`));
  }

  function say(text) {
    if (mv.status) mv.status.textContent = text || "";
    if (typeof setStatus === "function" && text) setStatus(text);
  }

  function show(on) {
    if (!mv.root) build();
    document.querySelector("main.layout")?.classList.toggle("movie-on", on);
    mv.root.hidden = !on;
    btn?.classList.toggle("is-on", on);
    btn?.setAttribute("aria-pressed", on ? "true" : "false");
    if (!on) pause();
  }

  function lengthText(seconds) {
    const whole = Math.round(Number(seconds) || 0);
    if (whole < 60) return `${whole} second${whole === 1 ? "" : "s"}`;
    const minutes = Math.floor(whole / 60);
    const rest = whole % 60;
    if (!rest) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    return `${minutes} minute${minutes === 1 ? "" : "s"} ${rest} second${rest === 1 ? "" : "s"}`;
  }

  /** 75.3 → "1:15.3". */
  function clock(seconds, tenths = true) {
    const s = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(s / 60);
    const rest = s - minutes * 60;
    const secs = tenths ? rest.toFixed(1).padStart(4, "0") : String(Math.floor(rest)).padStart(2, "0");
    return `${minutes}:${secs}`;
  }

  /** How fast this clip plays: the movie speed times this clip's own speed. */
  function clipSpeed(seg) {
    return (mv.project?.speed || 1) * (seg?.rate || 1);
  }

  /** Where each clip sits on the movie clock, after the speed change. */
  function segments(project) {
    const first = new Map();
    let cursor = 0;
    return (project?.clips || []).map((clip, i) => {
      if (!first.has(clip.path)) first.set(clip.path, clip.id);
      const rate = Number(clip.rate) || 1;
      const speed = (project?.speed || 1) * rate;
      const len = Math.max(0, ((clip.end || 0) - (clip.start || 0)) / speed);
      const seg = {
        i,
        name: clip.name || "Video",
        path: clip.path,
        url: `/movie/media?clip=${encodeURIComponent(first.get(clip.path))}`,
        start: clip.start || 0,
        end: clip.end || 0,
        still: Boolean(clip.still),
        duration: Number(clip.duration) || 0,
        rotate: Number(clip.rotate) || 0,
        scale: Number(clip.scale) || 1,
        stretch: Number(clip.stretch) || 1,
        shiftX: Number(clip.shiftX) || 0,
        shiftY: Number(clip.shiftY) || 0,
        opacity: clip.opacity == null ? 1 : Number(clip.opacity),
        clipVolume: clip.clipVolume == null ? 1 : Number(clip.clipVolume),
        clipMuted: Boolean(clip.clipMuted),
        rate,
        hidden: Boolean(clip.hidden),
        blur: Number(clip.blur) || 0,
        mask: clip.mask || "",
        blend: clip.blend || "",
        zoom: Boolean(clip.zoom),
        zoomOff: Boolean(clip.zoomOff),
        t0: cursor,
        t1: cursor + len,
      };
      cursor += len;
      return seg;
    });
  }

  function segAt(t) {
    const index = mv.segs.findIndex((seg) => t < seg.t1);
    return index < 0 ? mv.segs.length - 1 : index;
  }

  // ---- Player ----
  //
  // Transitions work like the exporter's: each one is centred on the cut. The next
  // clip starts half a transition early. While it comes in, the clip going out is a
  // snapshot on the ghost layer that fades, slides, wipes, opens, or zooms away.

  const TRANSITION_KINDS = ["crossfade", "black", "white", "slide", "wipe", "circle", "zoom"];

  /** The transition at cut `k` (the cut before clip k). Random walks the list like the exporter. */
  function transitionKind(k) {
    const kind = mv.project?.transition || "";
    if (kind !== "random") return kind;
    return TRANSITION_KINDS[((Math.max(1, k) - 1) * 5 + 2) % 7];
  }

  /** How long each transition lasts. 0 when there are none. Same rule as the exporter. */
  function transitionSpan() {
    if (mv.segs.length < 2 || !mv.project?.transition) return 0;
    return Math.min(mv.project.transitionSeconds || 1, ...mv.segs.map((seg) => seg.t1 - seg.t0));
  }

  /** Clip k comes on screen this long before its cut. */
  function lead(index) {
    return index > 0 ? transitionSpan() / 2 : 0;
  }

  /** The clip on screen at movie time t. */
  function clipOnScreen(t) {
    let index = 0;
    for (let k = 1; k < mv.segs.length; k++) {
      if (t >= mv.segs[k].t0 - lead(k)) index = k;
    }
    return index;
  }

  /** Movie time → this clip's own time. Below the clip's start during a transition in. */
  function clipTime(seg, t) {
    return seg.start + (t - seg.t0) * clipSpeed(seg);
  }

  /** Puts clip `index` on screen at movie time t. */
  function load(index, t, autoplay) {
    const seg = mv.segs[index];
    const video = mv.preview;
    if (!seg || !video) return;
    mv.cur = index;
    const token = ++mv.loadToken;
    mv.photo.hidden = !seg.still;
    video.hidden = seg.still;
    mv.hold = false;
    if (seg.still) {
      // A photo has no clock of its own. The page clock moves the playhead instead.
      video.pause();
      if (mv.photo.getAttribute("src") !== seg.url) mv.photo.src = seg.url;
      mv.stillFrom = performance.now() - (t - seg.t0) * 1000;
      return;
    }
    const at = clipTime(seg, t);
    const go = () => {
      if (token !== mv.loadToken) return;
      video.playbackRate = Math.min(16, Math.max(0.0625, clipSpeed(seg)));
      const loud = (mv.project?.muted || seg.clipMuted || seg.hidden) ? 0 : (mv.project?.volume || 1) * seg.clipVolume;
      video.volume = Math.min(1, Math.max(0, loud));
      const limit = seg.duration || video.duration || seg.end;
      video.currentTime = Math.min(limit, Math.max(0, at));
      if (!autoplay) return;
      if (at < 0) {
        // No footage before the clip's start: hold the first frame until the cut, like the exporter.
        mv.hold = true;
        mv.holdFrom = performance.now();
        mv.holdT = t;
        video.pause();
      } else {
        video.play().catch(() => {});
      }
    };
    if (mv.loadedPath !== seg.path) {
      mv.loadedPath = seg.path;
      video.src = seg.url;
      video.addEventListener("loadedmetadata", go, { once: true });
    } else {
      go();
    }
  }

  /** The song loops under the movie. The preview does not dip it for speech; the export does. */
  function syncMusic(start) {
    const music = mv.project?.music;
    if (!mv.music || !music) return;
    const length = music.duration || 0;
    if (length > 0) mv.music.currentTime = mv.t % length;
    mv.music.volume = Math.min(1, Math.max(0, music.volume));
    if (start) mv.music.play().catch(() => {});
  }

  function seek(t) {
    if (!mv.segs.length) return;
    mv.t = Math.min(Math.max(0, t), mv.total);
    if (mv.playing) syncMusic(false);
    const index = clipOnScreen(mv.t);
    load(index, mv.t, mv.playing);
    ghostForSeek(index, mv.t);
    draw();
  }

  function play() {
    if (!mv.segs.length) return;
    if (mv.t >= mv.total - 0.05) mv.t = 0;
    mv.playing = true;
    seek(mv.t);
    syncMusic(true);
    mv.playBtn.textContent = "❚❚";
    mv.playBtn.setAttribute("aria-label", "Pause");
    cancelAnimationFrame(mv.frame);
    mv.frame = requestAnimationFrame(tick);
  }

  function pause() {
    mv.playing = false;
    mv.hold = false;
    mv.preview?.pause();
    mv.music?.pause();
    cancelAnimationFrame(mv.frame);
    if (mv.playBtn) {
      mv.playBtn.textContent = "▶";
      mv.playBtn.setAttribute("aria-label", "Play");
    }
  }

  /** Follows the clip while it plays and brings the next one on at each transition. */
  function tick() {
    if (!mv.playing) return;
    const seg = mv.segs[mv.cur];
    const video = mv.preview;
    if (seg?.still) {
      mv.t = seg.t0 + (performance.now() - mv.stillFrom) / 1000;
    } else if (seg && mv.hold) {
      mv.t = mv.holdT + (performance.now() - mv.holdFrom) / 1000;
      if (clipTime(seg, mv.t) >= 0) {
        mv.hold = false;
        video.play().catch(() => {});
      }
    } else if (seg && video.readyState >= 1 && !video.seeking) {
      mv.t = seg.t0 + (video.currentTime - seg.start) / clipSpeed(seg);
    }
    const next = mv.segs[mv.cur + 1];
    if (next && mv.t >= next.t0 - lead(next.i) - 0.001) {
      nextClip();
    } else if (!next && (mv.t >= mv.total - 0.02 || (seg && !seg.still && video.ended))) {
      pause();
      mv.t = mv.total;
    }
    draw();
    if (mv.playing) mv.frame = requestAnimationFrame(tick);
  }

  /** The next clip comes on. The one leaving is kept as a picture for the transition. */
  function nextClip() {
    const next = mv.cur + 1;
    if (next >= mv.segs.length) {
      pause();
      mv.t = mv.total;
      return;
    }
    const leaving = mv.segs[mv.cur];
    if (lead(next) > 0 && snapshot(leaving.still ? mv.photo : mv.preview, leaving, mv.t)) mv.ghostCut = next;
    mv.t = mv.segs[next].t0 - lead(next);
    load(next, mv.t, true);
  }

  /** Draws the clip's current frame on the ghost canvas, with the clip's own look. */
  function snapshot(node, seg, t) {
    const canvas = mv.ghostCanvas;
    if (!canvas || !mv.stage) return false;
    const nw = node.videoWidth || node.naturalWidth || 0;
    const nh = node.videoHeight || node.naturalHeight || 0;
    const W = mv.stage.clientWidth;
    const H = mv.stage.clientHeight;
    if (!nw || !nh || !W || !H) return false;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const fit = Math.min(W / nw, H / nh);
    try {
      ctx.drawImage(node, (W - nw * fit) / 2, (H - nh * fit) / 2, nw * fit, nh * fit);
    } catch {
      return false;
    }
    canvas.dataset.nw = String(nw);
    canvas.dataset.nh = String(nh);
    dressClip(canvas, seg, t);
    return true;
  }

  /** After a scrub into a transition, the leaving clip's last frame comes from a hidden copy. */
  function ghostForSeek(index, t) {
    const span = transitionSpan();
    if (index === 0 || span <= 0 || t >= mv.segs[index].t0 + span / 2) return;
    if (mv.ghostCut === index) return;
    const leaving = mv.segs[index - 1];
    const token = ++mv.seekerToken;
    const done = (node) => {
      if (token !== mv.seekerToken) return;
      if (snapshot(node, leaving, leaving.t1)) {
        mv.ghostCut = index;
        draw();
      }
    };
    if (leaving.still) {
      if (mv.seekerPhoto.getAttribute("src") === leaving.url && mv.seekerPhoto.complete) return done(mv.seekerPhoto);
      mv.seekerPhoto.addEventListener("load", () => done(mv.seekerPhoto), { once: true });
      mv.seekerPhoto.src = leaving.url;
      return;
    }
    const video = mv.seekerVideo;
    const park = () => {
      video.addEventListener("seeked", () => done(video), { once: true });
      video.currentTime = Math.max(0, leaving.end - 0.05);
    };
    if (video.getAttribute("src") !== leaving.url) {
      video.addEventListener("loadedmetadata", park, { once: true });
      video.src = leaving.url;
    } else {
      park();
    }
  }

  /** The leaving clip during a transition: p runs 0 to 1 across it. Null outside one. */
  function activeCut(t) {
    const span = transitionSpan();
    if (span <= 0) return null;
    const k = clipOnScreen(t);
    const at = mv.segs[k].t0;
    if (k === 0 || t >= at + span / 2) return null;
    return { k, kind: transitionKind(k), p: Math.min(1, Math.max(0, (t - (at - span / 2)) / span)), span };
  }

  function drawGhost(cut) {
    if (!mv.ghost) return;
    if (!cut || cut.kind === "black" || cut.kind === "white" || mv.ghostCut !== cut.k) {
      mv.ghost.hidden = true;
      return;
    }
    const p = cut.p;
    const style = mv.ghost.style;
    style.opacity = "1";
    style.transform = "";
    style.clipPath = "";
    style.maskImage = "";
    style.webkitMaskImage = "";
    switch (cut.kind) {
      case "slide":
        style.transform = `translateX(${-p * 100}%)`;
        break;
      case "wipe":
        style.clipPath = `inset(0 ${p * 100}% 0 0)`;
        break;
      case "circle": {
        const r = `${p * 100}%`;
        style.maskImage = `radial-gradient(circle, transparent ${r}, #000 ${r})`;
        style.webkitMaskImage = style.maskImage;
        break;
      }
      case "zoom":
        style.opacity = String(1 - p);
        style.transform = `scale(${1 + 0.35 * p})`;
        break;
      default:
        style.opacity = String(1 - p);
    }
    mv.ghost.hidden = false;
  }

  /** Playhead, clock, caption and fade for the time mv.t. */
  function draw() {
    if (!mv.timeLabel) return;
    const total = mv.total || 0;
    const t = mv.t;
    mv.timeLabel.textContent = `${clock(t)} / ${clock(total)}`;
    mv.playhead.style.left = total ? `${(t / total) * 100}%` : "0";
    const project = mv.project || {};
    const caption = (project.captions || []).find((item) => t >= item.start && t < item.end);
    mv.caption.textContent = caption?.text || "";
    mv.caption.hidden = !caption;
    let dark = 0;
    if (project.fadeIn > 0 && t < project.fadeIn) dark = 1 - t / project.fadeIn;
    if (project.fadeOut > 0 && t > total - project.fadeOut) {
      dark = Math.max(dark, (t - (total - project.fadeOut)) / project.fadeOut);
    }
    // Transitions. Dips darken the fade layer; the others show the other clip on the ghost layer.
    let flash = "#000";
    const cut = activeCut(t);
    if (cut && (cut.kind === "black" || cut.kind === "white")) {
      dark = Math.max(dark, 1 - Math.abs(cut.p - 0.5) * 2);
      if (cut.kind === "white") flash = "#fff";
    }
    drawGhost(cut);
    mv.fade.style.background = flash;
    mv.fade.style.opacity = String(Math.min(1, Math.max(0, dark)));
    dressStage(project);
    const playing = segAt(t);
    const seg = mv.segs[mv.cur] || mv.segs[playing];
    dressClip(mv.preview, seg && !seg.still ? seg : null, t);
    dressClip(mv.photo, seg && seg.still ? seg : null, t);
    mv.track.querySelectorAll(".movie-block").forEach((block, i) => block.classList.toggle("is-live", i === playing));
    updateTools();
  }

  const FRAME_COLORS = {
    black: "#000", white: "#fff", blue: "#1d4ed8", red: "#dc2626", green: "#15803d",
    yellow: "#eab308", orange: "#ea580c", pink: "#db2777", purple: "#7e22ce", gray: "#6b7280",
    navy: "#1e3a5f", teal: "#0f766e",
  };

  /** Frame shape, background, cinema bars, and the preview-only guides. */
  function dressStage(project) {
    if (!mv.stage) return;
    const width = project.width || 1920;
    const height = project.height || 1080;
    mv.stage.style.aspectRatio = `${width} / ${height}`;
    mv.stage.style.maxWidth = height > width ? "min(100%, 36vh)" : `calc(36vh * ${width / height})`;
    mv.stage.style.background = FRAME_COLORS[project.background] || "#000";
    if (mv.bars) mv.bars.hidden = !project.bars;
    if (mv.guide) {
      mv.guide.hidden = !project.guide || project.guide === "none";
      mv.guide.className = project.guide === "grid" ? "movie-guide is-grid" : project.guide === "phone" ? "movie-guide is-phone" : "movie-guide";
    }
    const captionColor = FRAME_COLORS[project.captionColor] || "#fff";
    mv.caption.style.color = captionColor;
    const size = Number(project.captionSize) || 52;
    mv.caption.style.fontSize = `${Math.max(13, Math.min(28, size / 3.2))}px`;
  }

  /** Size, place, blur, circle, and see-through for the clip on screen. */
  function dressClip(node, seg, t) {
    if (!node) return;
    if (!seg) {
      node.style.transform = "";
      node.style.opacity = "";
      node.style.filter = "";
      node.style.clipPath = "";
      node.style.mixBlendMode = "";
      node.style.visibility = "";
      return;
    }
    const width = mv.project?.width || 1920;
    const height = mv.project?.height || 1080;
    // A quarter turn swaps the picture's sides. Scale so the turned picture fills the frame
    // the way the exporter's turn-then-fit does, instead of shrinking to the frame's short side.
    let turn = 1;
    if (seg.rotate % 180) {
      const nw = node.videoWidth || node.naturalWidth || Number(node.dataset.nw) || 0;
      const nh = node.videoHeight || node.naturalHeight || Number(node.dataset.nh) || 0;
      turn = nw && nh ? Math.min(width / nh, height / nw) / Math.min(width / nw, height / nh) : Math.min(width, height) / Math.max(width, height);
    }
    let sx = seg.scale * (seg.stretch || 1) * turn;
    let sy = (seg.scale / Math.max(0.2, seg.stretch || 1)) * turn;
    const plain = seg.scale === 1 && seg.stretch === 1 && !seg.shiftX && !seg.shiftY && !seg.blur && !seg.mask;
    const projectZoom = seg.still && mv.project?.photoZoom && !seg.zoomOff;
    if (plain && (seg.zoom || projectZoom)) {
      const part = (t - seg.t0) / Math.max(0.01, seg.t1 - seg.t0);
      const zoom = 1 + 0.08 * Math.min(1, Math.max(0, part));
      sx *= zoom;
      sy *= zoom;
    }
    node.style.transform = `translate(${seg.shiftX * 100}%, ${seg.shiftY * 100}%) scale(${sx}, ${sy}) rotate(${seg.rotate}deg)`;
    node.style.opacity = String(seg.opacity);
    node.style.filter = seg.blur >= 0.5 ? `blur(${Math.min(12, seg.blur * 0.45)}px)` : "";
    node.style.clipPath = seg.mask === "circle" ? "circle(50%)" : "";
    node.style.mixBlendMode = seg.blend || "";
    node.style.visibility = seg.hidden ? "hidden" : "";
  }

  // ---- Timeline ----

  function tickStep(total) {
    for (const step of [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]) {
      if (total / step <= 8) return step;
    }
    return 3600;
  }

  function paintTimeline(project) {
    const total = mv.total;
    mv.ruler.replaceChildren();
    const step = tickStep(total);
    // The last mark would hang past the right edge, so it is left off near the end.
    for (let at = 0; at < total - step * 0.4; at += step) {
      const mark = el("span", "movie-tick", clock(at, false));
      mark.style.left = `${(at / total) * 100}%`;
      mv.ruler.append(mark);
    }

    mv.track.replaceChildren();
    for (const seg of mv.segs) {
      const block = el("div", seg.still ? "movie-block is-photo" : "movie-block");
      block.style.width = `${((seg.t1 - seg.t0) / total) * 100}%`;
      block.classList.toggle("is-selected", seg.i === mv.selected);
      block.classList.toggle("is-hidden", seg.hidden);
      block.title = `${seg.still ? "Photo" : "Clip"} ${seg.i + 1}: ${seg.name}, ${lengthText(seg.t1 - seg.t0)}`;
      if (seg.still) block.style.backgroundImage = `linear-gradient(180deg, rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.55)), url("${seg.url}")`;
      block.append(el("span", "movie-block-num", String(seg.i + 1)), el("span", "movie-block-name", seg.name));
      block.dataset.index = String(seg.i);
      mv.track.append(block);
    }
    const fadeIn = el("div", "movie-fadein");
    fadeIn.style.width = `${(Math.min(project.fadeIn || 0, total) / total) * 100}%`;
    const fadeOut = el("div", "movie-fadeout");
    fadeOut.style.width = `${(Math.min(project.fadeOut || 0, total) / total) * 100}%`;
    mv.track.append(fadeIn, fadeOut);
    // The repaint above cleared the track, so the drop marker goes back in.
    mv.track.append(mv.dropMark);
    mv.marks = el("div", "movie-marks");
    mv.track.append(mv.marks);

    mv.capTrack.replaceChildren();
    for (const caption of project.captions || []) {
      const block = el("div", "movie-capblock", caption.text);
      block.style.left = `${(caption.start / total) * 100}%`;
      block.style.width = `${((caption.end - caption.start) / total) * 100}%`;
      block.title = `${caption.text} (${clock(caption.start)} to ${clock(caption.end)})`;
      mv.capTrack.append(block);
    }
    mv.capTrack.hidden = !(project.captions || []).length;
    mv.marks?.replaceChildren();
    for (const at of project.bookmarks || []) {
      const mark = el("span", "movie-bookmark");
      mark.style.left = `${(at / total) * 100}%`;
      mark.title = `Bookmark at ${clock(at)}`;
      mv.marks.append(mark);
    }
  }

  /** Click or drag on the timeline to move the playhead. Click a clip to pick it. */
  /**
   * Click anywhere to move the playhead; drag on the ruler to scrub.
   * Drag a clip block sideways to put it somewhere else in the order.
   */
  function wireTimeline() {
    let drag = null;
    const timeAt = (event) => {
      const box = mv.lanes.getBoundingClientRect();
      return ((event.clientX - box.left) / box.width) * mv.total;
    };
    // The slot (0 … clips) the pointer is over: before block n, or after the last.
    const slotAt = (event) => {
      const blocks = [...mv.track.querySelectorAll(".movie-block")];
      for (const [i, block] of blocks.entries()) {
        const box = block.getBoundingClientRect();
        if (event.clientX < box.left + box.width / 2) return i;
      }
      return blocks.length;
    };
    const showSlot = (slot) => {
      const blocks = [...mv.track.querySelectorAll(".movie-block")];
      const box = mv.track.getBoundingClientRect();
      const edge = slot < blocks.length ? blocks[slot].getBoundingClientRect().left : blocks[blocks.length - 1].getBoundingClientRect().right;
      mv.dropMark.style.left = `${edge - box.left}px`;
      mv.dropMark.hidden = false;
    };
    mv.lanes.addEventListener("pointerdown", (event) => {
      if (!mv.segs.length) return;
      mv.lanes.setPointerCapture(event.pointerId);
      const block = event.target.closest?.(".movie-block");
      drag = { x: event.clientX, block: block ? Number(block.dataset.index) : -1, moving: false, scrub: !block };
      if (block) select(Number(block.dataset.index));
      seek(timeAt(event));
    });
    mv.lanes.addEventListener("pointermove", (event) => {
      if (!drag) return;
      if (drag.scrub) {
        seek(timeAt(event));
        return;
      }
      if (!drag.moving && Math.abs(event.clientX - drag.x) < 8) return;
      drag.moving = true;
      mv.track.querySelectorAll(".movie-block")[drag.block]?.classList.add("is-dragging");
      drag.slot = slotAt(event);
      showSlot(drag.slot);
    });
    const stop = () => {
      if (!drag) return;
      const { block, moving, slot } = drag;
      drag = null;
      mv.dropMark.hidden = true;
      mv.track.querySelectorAll(".movie-block").forEach((node) => node.classList.remove("is-dragging"));
      if (!moving || slot == null || block < 0) return;
      // Dropping on its own place, or the slot right after it, changes nothing.
      if (slot === block || slot === block + 1) return;
      if (slot === 0) hear(`move clip ${block + 1} to the start`);
      else if (slot >= mv.segs.length) hear(`move clip ${block + 1} to the end`);
      else hear(`move clip ${block + 1} before clip ${slot + 1}`);
    };
    mv.lanes.addEventListener("pointerup", stop);
    mv.lanes.addEventListener("pointercancel", stop);
  }

  function paintInspector() {
    if (!mv.inspector) return;
    const seg = mv.segs[mv.selected];
    mv.inspectorBody.hidden = !seg;
    mv.inspector.classList.toggle("is-empty", !seg);
    if (!seg) {
      mv.inspectorTitle.textContent = mv.segs.length ? "Pick a clip on the timeline to change its look." : "";
      return;
    }
    mv.inspectorTitle.textContent = `${seg.still ? "Photo" : "Clip"} ${seg.i + 1} · ${seg.name}`;
    const clip = mv.project?.clips?.[seg.i] || {};
    mv.hideBtn.textContent = clip.hidden ? "Show" : "Hide";
    mv.hideBtn.classList.toggle("is-on", Boolean(clip.hidden));
    mv.clipMuteBtn.textContent = clip.clipMuted ? "Unmute" : "Mute";
    mv.clipMuteBtn.classList.toggle("is-on", Boolean(clip.clipMuted));
    mv.clipMuteBtn.disabled = seg.still;
    mv.clipVolumePick.disabled = seg.still;
    mv.maskBtn.classList.toggle("is-on", clip.mask === "circle");
    mv.zoomClipBtn.classList.toggle("is-on", Boolean(clip.zoom));
    // Stretch is a number in the project: 1.4 is wide, 0.7 is tall.
    mv.stretchPick.value = (clip.stretch ?? 1) > 1.05 ? "wide" : (clip.stretch ?? 1) < 0.95 ? "tall" : "normal";
    const opacity = String(clip.opacity ?? 1);
    mv.opacityPick.value = [...mv.opacityPick.options].some((option) => option.value === opacity) ? opacity : "1";
    mv.blendPick.value = clip.blend || "none";
    const rate = String(clip.rate ?? 1);
    mv.clipSpeedPick.value = [...mv.clipSpeedPick.options].some((option) => option.value === rate) ? rate : "1";
    const volume = String(Math.round((clip.clipVolume ?? 1) * 100));
    mv.clipVolumePick.value = [...mv.clipVolumePick.options].some((option) => option.value === volume) ? volume : "100";
  }

  function select(index) {
    mv.selected = index === mv.selected ? -1 : index;
    mv.track.querySelectorAll(".movie-block").forEach((block, i) => block.classList.toggle("is-selected", i === mv.selected));
    mv.clips.querySelectorAll(".movie-clip").forEach((row, i) => row.classList.toggle("is-selected", i === mv.selected));
    paintInspector();
    updateTools();
  }

  function updateTools() {
    const has = mv.segs.length > 0;
    const inside = has && mv.t > 0.1 && mv.t < mv.total - 0.1;
    mv.splitBtn.disabled = !inside;
    mv.cutBeforeBtn.disabled = !inside;
    mv.cutAfterBtn.disabled = !inside;
    mv.dropBtn.disabled = mv.selected < 0;
    mv.rotateBtn.disabled = mv.selected < 0;
    mv.dropBtn.textContent = mv.selected < 0 ? "Drop clip" : `Drop clip ${mv.selected + 1}`;
  }

  // ---- Panel ----

  /** After an add, picks the new clip and moves the playhead to it. */
  function landOnNew(project, previous) {
    const known = new Set((previous?.clips || []).map((clip) => clip.id));
    const fresh = (project?.clips || []).map((clip, i) => ({ id: clip.id, i })).filter((clip) => !known.has(clip.id));
    if (!fresh.length) return;
    const last = fresh[fresh.length - 1].i;
    // select() toggles, so clear first to be sure the new clip ends up picked.
    mv.selected = -1;
    select(last);
    seek(mv.segs[last]?.t0 ?? 0);
  }

  function paint(project) {
    if (!mv.clips) return;
    pause();
    mv.ghostCut = -1;
    mv.project = project || null;
    mv.segs = segments(project);
    mv.total = mv.segs.length ? mv.segs[mv.segs.length - 1].t1 : 0;
    if (mv.selected >= mv.segs.length) mv.selected = -1;
    mv.clips.replaceChildren();
    const hasClips = mv.segs.length > 0;
    mv.editor.hidden = !hasClips;
    if (!project) {
      mv.title.textContent = "Movie";
      mv.meta.textContent = "";
      mv.clips.append(el("p", "movie-empty", "No movie yet. Say: new movie called trip."));
      unload();
      return;
    }
    mv.title.textContent = project.name || "Movie";
    const bits = [lengthText(project.seconds), `${mv.segs.length} clip${mv.segs.length === 1 ? "" : "s"}`];
    if (project.speed && project.speed !== 1) bits.push(`speed ${project.speed}×`);
    if (project.muted) bits.push("muted");
    else if (project.volume != null && project.volume !== 1) bits.push(`volume ${Math.round(project.volume * 100)}%`);
    if (project.fadeIn) bits.push(`fade in ${project.fadeIn}s`);
    if (project.fadeOut) bits.push(`fade out ${project.fadeOut}s`);
    if (project.captions?.length) bits.push(`${project.captions.length} caption${project.captions.length === 1 ? "" : "s"}`);
    if (project.transition) bits.push(`${project.transition === "random" ? "random" : project.transition} transitions ${project.transitionSeconds}s`);
    if (project.music) bits.push(`♪ ${project.music.name} ${Math.round(project.music.volume * 100)}%`);
    if (project.width && project.height && !(project.width === 1920 && project.height === 1080)) {
      bits.push(`${project.width}×${project.height}`);
    }
    if (project.background && project.background !== "black") bits.push(`${project.background} background`);
    if (project.bars) bits.push("cinema bars");
    if (project.guide && project.guide !== "none") bits.push(`${project.guide} guide`);
    mv.meta.textContent = bits.join(" · ");
    mv.manual.open = !hasClips;
    if (!hasClips) {
      mv.clips.append(el("p", "movie-empty", "No clips yet. Press Add video or photo, or say: add the video, or add the photo, then its name."));
      unload();
      return;
    }
    for (const seg of mv.segs) {
      const row = el("li", "movie-clip");
      row.classList.toggle("is-selected", seg.i === mv.selected);
      row.append(
        el("span", "movie-clip-num", String(seg.i + 1)),
        el("span", "movie-clip-name", seg.name),
        el("span", "movie-clip-span", `${clock(seg.t0)} – ${clock(seg.t1)}`),
      );
      row.title = "Pick this clip";
      row.addEventListener("click", () => {
        select(seg.i);
        seek(seg.t0);
      });
      mv.clips.append(row);
    }
    const musicSrc = project.music ? `/movie/media?music=1&v=${encodeURIComponent(project.music.name)}` : "";
    if ((mv.music.getAttribute("src") || "") !== musicSrc) {
      if (musicSrc) mv.music.src = musicSrc;
      else mv.music.removeAttribute("src");
    }
    mv.transitionPick.value = project.transition || "";
    mv.zoomPick.checked = Boolean(project.photoZoom);
    mv.framePick.value = project.width === 1080 && project.height === 1920 ? "portrait"
      : project.width === 1080 && project.height === 1080 ? "square"
        : project.width === 1440 ? "classic" : "widescreen";
    mv.backgroundPick.value = project.background || "black";
    mv.blurBgBtn.classList.toggle("is-on", Boolean(project.blurBackground));
    mv.barsBtn.classList.toggle("is-on", Boolean(project.bars));
    mv.captionColorPick.value = project.captionColor || "white";
    mv.guidePick.value = project.guide || "none";
    paintInspector();
    mv.musicBtn.textContent = project.music ? "Remove music" : "♪ Add music";
    mv.preview.muted = Boolean(project.muted);
    mv.preview.volume = Math.min(1, Math.max(0, project.volume ?? 1));
    paintTimeline(project);
    seek(Math.min(mv.t, mv.total));
    updateTools();
  }

  function unload() {
    mv.t = 0;
    mv.cur = -1;
    mv.loadedPath = "";
    mv.loadToken++;
    mv.preview.removeAttribute("src");
    mv.preview.load();
    mv.photo.removeAttribute("src");
    mv.photo.hidden = true;
    mv.preview.hidden = false;
  }

  async function refresh() {
    try {
      const response = await fetch("/movie/status");
      const data = await response.json();
      paint(data.project || null);
      if (!data.project && data.said) say(data.said);
    } catch (err) {
      console.error("Failed while reading the movie:", err);
      say("The movie could not be read.");
    }
  }

  /** Seconds as the parser hears them, one decimal place. */
  function spoken(seconds) {
    return `${Math.round(seconds * 10) / 10} seconds`;
  }

  function build() {
    const root = el("section", "panel moviepanel");
    root.hidden = true;

    const bar = el("div", "movie-bar");
    mv.title = el("span", "movie-title", "Movie");
    mv.status = el("span", "movie-status", "");
    mv.status.setAttribute("role", "status");
    const add = button("+ Add video or photo", "Choose a video or a photo (HEIC works) in your home folder", () => pick(), "ghost-btn movie-add");
    const undo = button("↶ Undo", "Put the movie back one step", () => hear("undo the movie"));
    const redo = button("↷ Redo", "Put back the step you just undid", () => hear("redo the movie"));
    const orders = button("Orders", "Show the voice orders", () => {
      mv.manual.open = true;
      mv.manual.scrollIntoView({ block: "nearest" });
      say("The movie orders are listed below.");
    });
    const exp = button("Export mp4", "Make the mp4 in Movies", () => hear("export the movie"), "ghost-btn movie-export");
    const closeBtn = button("Close", "", () => show(false));
    bar.append(mv.title, mv.status, el("span", "movie-gap"), add, undo, redo, orders, exp, closeBtn);

    mv.editor = el("div", "movie-editor");
    const stage = el("div", "movie-stage");
    mv.stage = stage;
    mv.preview = document.createElement("video");
    mv.preview.className = "movie-preview";
    mv.preview.playsInline = true;
    mv.preview.preload = "auto";
    mv.preview.addEventListener("error", () => {
      if (!mv.preview.getAttribute("src")) return;
      pause();
      say("This clip cannot play in the preview. Export still works.");
    });
    mv.preview.addEventListener("click", () => (mv.playing ? pause() : play()));
    mv.photo = el("img", "movie-photo");
    mv.photo.alt = "";
    mv.photo.hidden = true;
    mv.photo.addEventListener("click", () => (mv.playing ? pause() : play()));
    mv.caption = el("div", "movie-caption");
    mv.caption.hidden = true;
    // The clip leaving during a transition, as a picture. The hidden copies feed it after a scrub.
    mv.ghost = el("div", "movie-ghost");
    mv.ghost.hidden = true;
    mv.ghostCanvas = document.createElement("canvas");
    mv.ghostCanvas.className = "movie-ghost-frame";
    mv.ghost.append(mv.ghostCanvas);
    mv.ghostCut = -1;
    mv.seekerToken = 0;
    mv.seekerVideo = document.createElement("video");
    mv.seekerVideo.muted = true;
    mv.seekerVideo.preload = "auto";
    mv.seekerVideo.className = "movie-seeker";
    mv.seekerPhoto = el("img", "movie-seeker");
    mv.seekerPhoto.alt = "";
    mv.fade = el("div", "movie-fade");
    mv.bars = el("div", "movie-bars");
    mv.bars.hidden = true;
    mv.guide = el("div", "movie-guide");
    mv.guide.hidden = true;
    stage.append(mv.preview, mv.photo, mv.ghost, mv.bars, mv.guide, mv.fade, mv.caption, mv.seekerVideo, mv.seekerPhoto);

    const transport = el("div", "movie-transport");
    mv.playBtn = button("▶", "Play or pause the edited movie", () => (mv.playing ? pause() : play()), "movie-play");
    mv.playBtn.setAttribute("aria-label", "Play");
    mv.timeLabel = el("span", "movie-time", "0:00.0 / 0:00.0");
    mv.splitBtn = button("Split here", "Make two clips at the playhead", () => hear(`split the movie at ${spoken(mv.t)}`), "ghost-btn small");
    mv.cutBeforeBtn = button("Cut before", "Drop everything before the playhead", () => hear(`cut the first ${spoken(mv.t)} of the movie`), "ghost-btn small");
    mv.cutAfterBtn = button("Cut after", "Drop everything after the playhead", () => hear(`cut the last ${spoken(mv.total - mv.t)} of the movie`), "ghost-btn small");
    mv.dropBtn = button("Drop clip", "Remove the picked clip", () => {
      if (mv.selected >= 0) hear(`drop clip ${mv.selected + 1}`);
    }, "ghost-btn small");
    mv.rotateBtn = button("Rotate ↻", "Turn the picked clip a quarter turn right", () => {
      if (mv.selected >= 0) hear(`rotate clip ${mv.selected + 1} right`);
    }, "ghost-btn small");
    transport.append(mv.playBtn, mv.timeLabel, el("span", "movie-gap"), mv.splitBtn, mv.cutBeforeBtn, mv.cutAfterBtn, mv.rotateBtn, mv.dropBtn);

    // Whole-movie looks: transitions, photo zoom, music, captions from speech, title card.
    const extras = el("div", "movie-extras");
    const pickLabel = el("label", "movie-field", "Transitions ");
    mv.transitionPick = document.createElement("select");
    mv.transitionPick.className = "movie-select";
    for (const [value, label] of [["", "None"], ["crossfade", "Crossfade"], ["black", "Dip to black"], ["white", "Dip to white"], ["slide", "Slide"], ["wipe", "Wipe"], ["circle", "Circle"], ["zoom", "Zoom"], ["random", "Random at each cut"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      mv.transitionPick.append(option);
    }
    mv.transitionPick.addEventListener("change", () => {
      const value = mv.transitionPick.value;
      const say = { "": "no transitions", black: "dip to black between clips", white: "dip to white between clips" }[value] || `use ${value} transitions between clips`;
      hear(say);
    });
    pickLabel.append(mv.transitionPick);
    const zoomLabel = el("label", "movie-field");
    mv.zoomPick = document.createElement("input");
    mv.zoomPick.type = "checkbox";
    mv.zoomPick.addEventListener("change", () => hear(mv.zoomPick.checked ? "zoom the photos" : "keep the photos still"));
    zoomLabel.append(mv.zoomPick, document.createTextNode(" Zoom photos"));
    mv.musicBtn = button("♪ Add music", "Choose a song to play under the movie", () => {
      if (mv.project?.music) hear("remove the music");
      else pick("music");
    }, "ghost-btn small");
    const makeMusicBtn = button("✦ Make music", "Write new music to fit the movie, online or on this Mac", () => {
      mv.musicForm.hidden = !mv.musicForm.hidden;
      if (!mv.musicForm.hidden) mv.moodInput.focus();
    }, "ghost-btn small");
    const captionBtn = button("Captions from speech", "Listen to the clips and write captions", () => hear("caption the movie"), "ghost-btn small");
    const titleBtn = button("Title card", "Add an animated title at the start", () => {
      mv.titleForm.hidden = !mv.titleForm.hidden;
      if (!mv.titleForm.hidden) mv.titleInput.focus();
    }, "ghost-btn small");
    extras.append(pickLabel, zoomLabel, mv.musicBtn, makeMusicBtn, captionBtn, titleBtn);

    // Mood for new music. Empty means: read the mood off the movie.
    mv.musicForm = el("form", "movie-titleform");
    mv.musicForm.hidden = true;
    mv.moodInput = el("input", "movie-input");
    mv.moodInput.placeholder = "Mood, such as calm piano, or leave empty to fit the movie";
    mv.moodInput.maxLength = 120;
    mv.enginePick = choice("Where the music is made", [["auto", "Online, else this Mac"], ["online", "Online (Lyria)"], ["local", "This Mac (MusicGen)"]], () => {});
    const musicGo = el("button", "ghost-btn small", "Make");
    musicGo.type = "submit";
    mv.musicForm.append(mv.moodInput, mv.enginePick, musicGo);
    mv.musicForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const mood = mv.moodInput.value.trim().replace(/[.!?]+$/, "");
      const where = { online: " online", local: " offline" }[mv.enginePick.value] || "";
      mv.musicForm.hidden = true;
      hear(`make ${mood ? `${mood} ` : ""}music for the movie${where}`);
    });

    // The whole frame: shape, what shows behind a clip, bars, captions, guides, bookmarks.
    const frameBar = el("div", "movie-toolbar");
    mv.framePick = choice("Shape of the movie", [["widescreen", "Widescreen 16:9"], ["portrait", "Portrait 9:16"], ["square", "Square"], ["classic", "Classic 4:3"]], (value) => hear(`make the movie ${value}`));
    mv.backgroundPick = choice("Colour behind clips that do not fill the frame", ["black", "white", "blue", "red", "green", "yellow", "orange", "pink", "purple", "gray", "navy", "teal"].map((color) => [color, color[0].toUpperCase() + color.slice(1)]), (value) => hear(`set the movie background to ${value}`));
    mv.blurBgBtn = button("Blur fill", "Fill the bars with a soft copy of the clip", () => hear(mv.project?.blurBackground ? "stop blurring the background" : "blur the background"), "ghost-btn small movie-toggle");
    mv.barsBtn = button("Cinema bars", "Black bars at the top and bottom", () => hear(mv.project?.bars ? "remove the cinema bars" : "add cinema bars"), "ghost-btn small movie-toggle");
    mv.captionColorPick = choice("Caption colour", ["white", "yellow", "blue", "red", "green", "orange", "pink"].map((color) => [color, color[0].toUpperCase() + color.slice(1)]), (value) => hear(`make the captions ${value}`));
    const capSmaller = button("A−", "Smaller captions", () => hear("make the captions smaller"), "ghost-btn small");
    const capBigger = button("A+", "Bigger captions", () => hear("make the captions bigger"), "ghost-btn small");
    const capClear = button("Clear", "Remove every caption", () => hear("remove the captions from the movie"), "ghost-btn small");
    const subsBtn = button("From srt file", "Use an srt subtitle file as the captions", () => pick("subtitles"), "ghost-btn small");
    mv.guidePick = choice("Guides on the preview only", [["none", "No guide"], ["grid", "Grid"], ["phone", "Phone guide"]], (value) => hear(value === "none" ? "hide the guides" : value === "grid" ? "show the grid" : "show the phone guide"));
    const markBtn = button("⚑ Bookmark here", "Mark this moment", () => hear("bookmark here"), "ghost-btn small");
    const goMarkBtn = button("Go to bookmark", "Jump to the last bookmark", () => hear("go to the bookmark"), "ghost-btn small");
    const clearMarkBtn = button("Clear", "Remove the bookmarks", () => hear("remove the bookmarks"), "ghost-btn small");
    frameBar.append(
      group("Frame", mv.framePick, mv.backgroundPick, mv.blurBgBtn, mv.barsBtn),
      group("Captions", mv.captionColorPick, capSmaller, capBigger, subsBtn, capClear),
      group("Preview", mv.guidePick, markBtn, goMarkBtn, clearMarkBtn),
    );

    // One clip: what the picked clip looks and sounds like.
    mv.inspector = el("div", "movie-inspector");
    mv.inspectorTitle = el("div", "movie-inspector-title", "Pick a clip on the timeline to change its look.");
    const rotL = button("↺", "Turn left", () => clipHear("rotate clip N left"), "ghost-btn small");
    const rotR = button("↻", "Turn right", () => clipHear("rotate clip N right"), "ghost-btn small");
    const flip = button("Upside down", "Turn upside down", () => clipHear("turn clip N upside down"), "ghost-btn small");
    mv.hideBtn = button("Hide", "Keep the clip's place but turn its picture and sound off", () => clipHear(mv.segs[mv.selected]?.hidden ? "show clip N" : "hide clip N"), "ghost-btn small movie-toggle");
    mv.clipMuteBtn = button("Mute", "Turn off this clip's sound only", () => clipHear(mv.segs[mv.selected]?.clipMuted ? "unmute clip N" : "mute clip N"), "ghost-btn small movie-toggle");
    const dup = button("Duplicate", "Play this clip twice in a row", () => clipHear("duplicate clip N"), "ghost-btn small");
    const earlier = button("◀ Earlier", "Swap with the clip before it", () => clipHear("move clip N earlier"), "ghost-btn small");
    const later = button("Later ▶", "Swap with the clip after it", () => clipHear("move clip N later"), "ghost-btn small");
    const toStart = button("⇤ To start", "Move this clip to the start", () => clipHear("move clip N to the start"), "ghost-btn small");
    const toEnd = button("To end ⇥", "Move this clip to the end", () => clipHear("move clip N to the end"), "ghost-btn small");
    const left = button("←", "Nudge left", () => clipHear("move clip N left"), "ghost-btn small");
    const right = button("→", "Nudge right", () => clipHear("move clip N right"), "ghost-btn small");
    const up = button("↑", "Nudge up", () => clipHear("move clip N up"), "ghost-btn small");
    const down = button("↓", "Nudge down", () => clipHear("move clip N down"), "ghost-btn small");
    const center = button("Center", "Put the clip back in the middle", () => clipHear("move clip N to the center"), "ghost-btn small");
    const smaller = button("Smaller", "Shrink the clip", () => clipHear("make clip N smaller"), "ghost-btn small");
    const bigger = button("Bigger", "Grow the clip", () => clipHear("make clip N bigger"), "ghost-btn small");
    mv.stretchPick = choice("Stretch the shape", [["normal", "Normal shape"], ["wide", "Stretch wide"], ["tall", "Stretch tall"]], (value) => clipHear(value === "normal" ? "stretch clip N back to normal" : `stretch clip N ${value}`));
    mv.opacityPick = choice("See-through", [["1", "Solid"], ["0.75", "75% visible"], ["0.5", "Half see-through"], ["0.25", "25% visible"]], (value) => clipHear(`set clip N opacity to ${Math.round(Number(value) * 100)} percent`));
    const blur = button("Blur", "Soften the clip", () => clipHear("blur clip N"), "ghost-btn small");
    const blurMore = button("Blur more", "Soften it further", () => clipHear("blur clip N more"), "ghost-btn small");
    const unblur = button("Sharp", "Make the clip sharp again", () => clipHear("unblur clip N"), "ghost-btn small");
    mv.maskBtn = button("Circle mask", "Show the clip inside a circle", () => clipHear(mv.segs[mv.selected]?.mask === "circle" ? "remove the mask from clip N" : "put a circle mask on clip N"), "ghost-btn small movie-toggle");
    mv.blendPick = choice("Blend with the background", [["none", "No blend"], ["multiply", "Multiply"], ["screen", "Screen"], ["overlay", "Overlay"]], (value) => clipHear(value === "none" ? "remove the blend from clip N" : `blend clip N with ${value}`));
    mv.zoomClipBtn = button("Slow zoom", "This clip pushes in slowly", () => clipHear(mv.segs[mv.selected]?.zoom ? "stop zooming clip N" : "zoom clip N"), "ghost-btn small movie-toggle");
    mv.clipSpeedPick = choice("Speed of this clip only", [["0.5", "½× speed"], ["1", "1× speed"], ["1.5", "1.5× speed"], ["2", "2× speed"]], (value) => clipHear(`set clip N speed to ${value}`));
    mv.clipVolumePick = choice("Volume of this clip only", [["100", "100% volume"], ["70", "70% volume"], ["40", "40% volume"], ["20", "20% volume"]], (value) => clipHear(`set clip N volume to ${value} percent`));
    const resetLook = button("Reset look", "Size, place, blur, mask and see-through back to normal", () => clipHear("reset the look of clip N"), "ghost-btn small");
    mv.inspectorBody = el("div", "movie-inspector-body");
    mv.inspectorBody.append(
      group("Turn", rotL, rotR, flip),
      group("Clip", mv.hideBtn, mv.clipMuteBtn, dup),
      group("Order", earlier, later, toStart, toEnd),
      group("Place", left, right, up, down, center),
      group("Size", smaller, bigger, mv.stretchPick),
      group("Look", mv.opacityPick, blur, blurMore, unblur, mv.maskBtn, mv.blendPick, mv.zoomClipBtn),
      group("Sound & speed", mv.clipSpeedPick, mv.clipVolumePick),
      group("", resetLook),
    );
    mv.inspector.append(mv.inspectorTitle, mv.inspectorBody);

    // Typed title, so the words keep their capitals. No browser prompt: the app window has none.
    mv.titleForm = el("form", "movie-titleform");
    mv.titleForm.hidden = true;
    mv.titleInput = el("input", "movie-input");
    mv.titleInput.placeholder = "Title, such as Rome in October";
    mv.titleInput.maxLength = 60;
    mv.subtitleInput = el("input", "movie-input");
    mv.subtitleInput.placeholder = "Subtitle (optional)";
    mv.subtitleInput.maxLength = 80;
    const titleGo = el("button", "ghost-btn small", "Make title");
    titleGo.type = "submit";
    mv.titleForm.append(mv.titleInput, mv.subtitleInput, titleGo);
    mv.titleForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const title = mv.titleInput.value.trim();
      if (!title) return;
      const subtitle = mv.subtitleInput.value.trim();
      mv.titleForm.hidden = true;
      mv.titleInput.value = "";
      mv.subtitleInput.value = "";
      hear(`add a title card saying ${title}${subtitle ? ` with the subtitle ${subtitle}` : ""}`);
    });

    const timeline = el("div", "movie-timeline");
    mv.ruler = el("div", "movie-ruler");
    mv.lanes = el("div", "movie-lanes");
    mv.track = el("div", "movie-track");
    mv.capTrack = el("div", "movie-captrack");
    mv.playhead = el("div", "movie-playhead");
    mv.dropMark = el("div", "movie-dropmark");
    mv.dropMark.hidden = true;
    mv.lanes.append(mv.ruler, mv.track, mv.capTrack, mv.playhead);
    timeline.append(mv.lanes);
    wireTimeline();

    mv.music = document.createElement("audio");
    mv.music.loop = true;
    mv.music.preload = "auto";
    mv.editor.append(stage, transport, timeline, extras, mv.titleForm, mv.musicForm, frameBar, mv.inspector, mv.music);

    mv.meta = el("p", "movie-meta", "");
    mv.clips = el("ol", "movie-clips");
    mv.manual = el("details", "movie-manual");
    mv.manual.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "Voice orders";
    const table = el("table", "movie-orders");
    const body = document.createElement("tbody");
    for (const row of window.MOVIE_ORDERS || []) {
      const tr = document.createElement("tr");
      tr.append(el("td", "", row.say), el("td", "", row.does));
      body.append(tr);
    }
    table.append(body);
    const note = el("p", "movie-note", "Say Hey, then the phrase. With this panel open you can leave off the words “the movie”.");
    mv.manual.append(summary, note, table);
    root.append(bar, mv.editor, mv.meta, mv.clips, mv.manual);
    document.querySelector("main.layout").append(root);
    mv.root = root;
  }

  function open() {
    if (!mv.root) build();
    window.brainWord?.close();
    window.brainSlides?.close();
    window.brainR?.close();
    window.brainPhoto?.close();
    window.brainCalendar?.close();
    window.brainStickies?.close();
    window.brainPlans?.close();
    window.brainScreen?.close();
    show(true);
    refresh();
  }

  function close() {
    if (!mv.root) return;
    show(false);
  }

  async function pick(kind = "") {
    if (mv.busy) return;
    mv.busy = true;
    mv.root?.classList.add("movie-busy");
    say(kind === "music" ? "Choose a song." : kind === "subtitles" ? "Choose an srt file." : "Choose a video or a photo.");
    try {
      const response = await fetch(`/movie/pick${kind ? `?kind=${kind}` : ""}`, { method: "POST" });
      const data = await response.json();
      if (data.cancelled) {
        say("No video was added.");
        return;
      }
      if (!response.ok) throw new Error(data.error || "That video could not be added.");
      const previous = mv.project;
      paint(data.project);
      landOnNew(data.project, previous);
      say(data.said || "Added the video.");
    } catch (err) {
      console.error("Failed while adding a video:", err);
      say(err.message || "That video could not be added.");
    } finally {
      mv.busy = false;
      mv.root?.classList.remove("movie-busy");
    }
  }

  let last = { key: "", at: 0 };

  /** True when this sentence was a movie order, so the brain should not also answer it. */
  function handle(question) {
    const openPanel = Boolean(mv.root && !mv.root.hidden);
    const order = window.parseMovieOrder?.(question, openPanel);
    if (!order) return false;
    const key = String(question || "").toLowerCase();
    if (key === last.key && Date.now() - last.at < 2500) return true;
    last = { key, at: Date.now() };
    if (order.op === "open" || order.op === "orders") {
      open();
      if (order.op === "orders") {
        if (mv.manual) mv.manual.open = true;
        say("The movie orders are listed on the right.");
      } else {
        say("Movie editor open. Say new movie called, then a name, or add the video and its name.");
      }
      return true;
    }
    if (order.op === "close") {
      close();
      say("Closed the movie editor.");
      return true;
    }
    if (order.op === "error") {
      open();
      say(order.error);
      return true;
    }
    if (!openPanel) open();
    hear(question);
    return true;
  }

  async function hear(text) {
    const local = window.parseMovieOrder?.(text, true);
    if (local?.op === "bookmark_here") text = `bookmark at ${spoken(mv.t)}`;
    else if (local?.op === "go_bookmark" || local?.op === "step") {
      if (local.op === "step") {
        seek(mv.t + (local.frames || 1) / (mv.project?.fps || 30));
        say(local.frames < 0 ? "One frame back." : "One frame forward.");
      } else {
        const marks = mv.project?.bookmarks || [];
        if (!marks.length) say("There is no bookmark yet. Say bookmark here.");
        else {
          seek(marks[marks.length - 1]);
          say("Jumped to the bookmark.");
        }
      }
      return;
    }
    if (mv.busy) {
      say("Still working on the last movie order.");
      return;
    }
    mv.busy = true;
    mv.root?.classList.add("movie-busy");
    say(/music for the movie|soundtrack/.test(text) ? `Writing the music… online this takes about as long as the movie (${lengthText(mv.total)}).`
      : /caption the movie|title card/.test(text) ? "Working on the movie… this can take a minute." : "Working on the movie…");
    try {
      const response = await fetch("/movie/hear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, open: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The movie could not be changed.");
      const previous = mv.project;
      if (data.project) paint(data.project);
      if (data.project && /^add the (?:video|photo|picture|image)\b|^add a title/i.test(text)) landOnNew(data.project, previous);
      if (/^export\b/i.test(text) && data.project?.exportPath) {
        const name = String(data.project.exportPath).split("/").pop();
        if (name) noteChatFile({ name, title: name, summary: "A movie exported from this chat.", made: true });
      }
      say(data.said || "Done.");
    } catch (err) {
      console.error("Failed while changing the movie:", err);
      say(err.message || "The movie could not be changed.");
    } finally {
      mv.busy = false;
      mv.root?.classList.remove("movie-busy");
    }
  }

  btn?.addEventListener("click", () => (mv.root && !mv.root.hidden ? close() : open()));

  window.brainMovie = {
    get open() {
      return Boolean(mv.root && !mv.root.hidden);
    },
    openPanel: open,
    close,
    handle,
  };
})();
