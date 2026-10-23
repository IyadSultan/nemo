/**
 * Brain, the pixel pet.
 *
 * The idea comes from Jessa Wolfe's Mochi: a small friend on the screen for an
 * ADHD brain. It does not nag. It keeps you company, makes asking feel good,
 * and holds the reply so you do not have to go looking for it.
 *
 * What you see:
 *   idle        breathes, blinks, and glances around
 *   morning     holds a coffee (a soft clock: it is still morning)
 *   Friday pm   wears sunglasses
 *   after 10pm  wears a nightcap (a soft cue that it is late)
 *   you ask     crouches, jumps, and throws a paper plane
 *   working     thinking dots over its head
 *   answer      a short bubble with the real answer, not just "Hi"
 *   something shipped, or a save   a proud double hop
 *   a failed ask   wide eyes and a shiver
 *   five quiet minutes   melts and a z drifts up; move the pointer to wake it
 *   rest the pointer on it   a blush and a heart
 *   each question today   a little rounder; back to normal tomorrow
 *
 * It looks like a cartoon brain: pink lumpy lobes split by a fold, a dark
 * outline, glinting black eyes, rosy cheeks, nub arms and two little legs.
 *
 * It is drawn on a 16 by 14 pixel grid, about 12 times a second, and only
 * while Brain is the mascot. The pixels are tiny, so this does not repaint
 * the whole window.
 */
(function startBrainPet() {
  const capsule = document.getElementById("capsule");
  const stage = document.getElementById("brainStage");
  const canvas = document.getElementById("brainPet");
  const bubble = document.getElementById("brainBubble");
  if (!capsule || !stage || !canvas || !bubble) return;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = 16;
  const H = 14;
  const QUIET_MS = 5 * 60 * 1000;
  const SNACK_KEY = "brainSnacks";
  // A reply that only says hello is skipped when a real sentence follows.
  const GREET = /^(?:hi|hello|hey)\b/i;
  const PROUD = /\b(?:went live|goes live|gone live|pushed|shipped|deployed|published)\b/i;

  // One letter per pixel. "." is empty. The colours live in PAL.
  // A cartoon brain: pink lobes (lighter on the left), a dark fold down the
  // middle, a dark outline, black eyes with a white glint, rosy cheeks.
  const PAL = {
    o: [52, 26, 40, 255],
    l: [250, 165, 205, 255],
    b: [240, 112, 170, 255],
    d: [200, 58, 125, 255],
    e: [22, 14, 20, 255],
    w: [255, 255, 255, 255],
    m: [52, 26, 40, 255],
    p: [228, 66, 118, 255],
    g: [22, 14, 20, 255],
    n: [46, 64, 180, 255],
    r: [255, 255, 255, 255],
    c: [240, 235, 225, 255],
    k: [120, 85, 60, 255],
    f: [255, 255, 255, 200],
    a: [142, 197, 255, 255],
    s: [255, 236, 150, 255],
    t: [210, 214, 222, 255],
    z: [190, 196, 210, 255],
  };

  // Every picture is 14 rows of 16 pixels. pic() warns if one is the wrong size.
  function pic(lines) {
    if (lines.length !== H) console.error("Brain picture has", lines.length, "rows, not", H);
    return lines.map((line, i) => {
      if (line.length !== W) console.error("Brain picture row", i, "has", line.length, "pixels:", line);
      return line.length >= W ? line.slice(0, W) : line + ".".repeat(W - line.length);
    });
  }

  // The brain sits on rows 2 to 12: lumpy top, nub arms, two little legs.
  // Rows 0 and 1 stay clear for thinking dots, the plane and the nightcap.
  const idle = pic([
    "................",
    "................",
    "...oooo..oooo...",
    "..ollllddbbbbo..",
    ".ollldlddbdbbbo.",
    ".olewllddbbewbo.",
    ".oleellddbbeebo.",
    "bolplllmmbbbpbob",
    ".olldllddbbdbbo.",
    "..ollllddbbbbo..",
    "...oooooooooo...",
    "....ob....bo....",
    "....oo....oo....",
    "................",
  ]);
  const row = (rows, i, line) => rows.map((r, k) => (k === i ? line : r));
  // A breath: the head sinks one row onto its feet.
  const squash = pic(["................", "................", "................"]
    .concat(idle.slice(2, 11), [idle[12], "................"]));
  const blink = row(row(idle, 5, ".olllllddbbbbbo."), 6, ".oleellddbbeebo.");
  const talk = row(row(idle, 7, "bolpllmmmmbbpbob"), 8, ".olldllmmbbdbbo.");
  const lookL = row(row(idle, 5, ".oewlllddbewbbo."), 6, ".oeelllddbeebbo.");
  const lookR = row(row(idle, 5, ".ollewlddbbbewo."), 6, ".olleelddbbbeeo.");
  const wide = row(row(row(idle, 4, ".olewdlddbdewbo."), 5, ".oleellddbbeebo."), 8, ".olldllmmbbdbbo.");
  const pet = row(row(idle, 5, ".olelllddbbbebo."), 6, ".oelellddbbebeo.");
  // Landed flat after the throw.
  const splat = pic([
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "...oooo..oooo...",
    ".olllllddbbbbbo.",
    "oleelllddbbbeebo",
    ".oooooooooooooo.",
    "................",
  ]);
  // Melted into a puddle, eyes shut.
  const sleep = pic([
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "...oooo..oooo...",
    ".olllllddbbbbbo.",
    "oleelllddbbbeebo",
    ".oooooooooooooo.",
  ]);
  const stretch = idle;
  // Sunglasses with a glint in each lens.
  const shades = pic([
    "................",
    "................",
    "................",
    "................",
    "................",
    "..gwgggggggwgg..",
    "..gggg....gggg..",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ]);
  // Striped nightcap, pompom flopped to the left.
  const cap = pic([
    ".rr.............",
    ".rrnnr..........",
    "...nrnrnrnrnr...",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
  ]);
  // Morning coffee by its right foot, steam curling up (two frames).
  const cupA = pic([
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "...............f",
    "..............f.",
    ".............kk.",
    ".............cc.",
    ".............cc.",
    "................",
  ]);
  const cupB = pic([
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "...............f",
    ".............kk.",
    ".............cc.",
    ".............cc.",
    "................",
  ]);
  const SPRITES = { idle, squash, blink, talk, lookL, lookR, wide, pet, splat, sleep, stretch };

  // Short poses. Each step is one frame at 12 per second.
  const ANIMS = {
    plane: [
      { body: "idle", oy: 1 },
      { body: "idle", oy: 1 },
      { body: "idle", oy: -2 },
      { body: "idle", oy: -2 },
      { body: "idle", plane: 0 },
      { body: "idle", plane: 3 },
      { body: "idle", plane: 7 },
      { body: "idle", plane: 11, spark: true },
      { body: "splat" },
      { body: "splat" },
      { body: "idle" },
    ],
    hop: [
      { body: "idle", oy: -1 },
      { body: "idle", oy: -2, spark: true },
      { body: "idle", oy: -1 },
      { body: "idle" },
      { body: "idle" },
      { body: "idle", oy: -1 },
      { body: "idle", oy: -2, spark: true },
      { body: "idle", oy: -1 },
      { body: "idle" },
    ],
    shiver: [
      { body: "wide", ox: 1 },
      { body: "wide", ox: -1 },
      { body: "wide", ox: 1 },
      { body: "wide", ox: -1 },
      { body: "wide", ox: 1 },
      { body: "wide", ox: -1 },
      { body: "wide" },
      { body: "idle" },
    ],
    stretch: [
      { body: "squash" },
      { body: "idle", oy: -2 },
      { body: "idle", oy: -2 },
      { body: "idle", oy: -1 },
      { body: "idle" },
      { body: "idle" },
    ],
  };

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const img = ctx.createImageData(W, H);
  let on = false;
  let timer = 0;
  let tick = 0;
  let anim = null;
  let nextAnim = "";
  let asleep = false;
  let quietSince = Date.now();
  let petUntil = 0;
  let look = 0;
  let glance = 0;
  let glanceDir = -1;
  let glanceIn = 36;
  let blinking = 0;
  let blinkIn = 48;
  let round = 0;
  let bubbleTimer = 0;
  let restTimer = 0;
  let restX = 0;
  let restY = 0;
  let seenActivity = "";
  let lastKey = "";
  let sentAt = 0;

  function dayKey() {
    return new Date().toLocaleDateString("en-CA");
  }

  function readSnacks() {
    try {
      const data = JSON.parse(localStorage.getItem(SNACK_KEY) || "{}");
      if (data.day !== dayKey()) return { day: dayKey(), n: 0 };
      return { day: data.day, n: Number(data.n) || 0 };
    } catch (err) {
      console.error("Brain pet failed while reading how round it is:", err);
      return { day: dayKey(), n: 0 };
    }
  }

  function syncRound() {
    const data = readSnacks();
    round = data.n >= 8 ? 2 : data.n >= 4 ? 1 : 0;
  }

  function bumpSnack() {
    const data = readSnacks();
    data.n += 1;
    try {
      localStorage.setItem(SNACK_KEY, JSON.stringify(data));
    } catch (err) {
      console.error("Brain pet failed while saving a snack:", err);
    }
    syncRound();
  }

  // Morning coffee, Friday afternoon sunglasses, nightcap after 10pm.
  function outfitNow() {
    const now = new Date();
    const hour = now.getHours();
    if (hour >= 22 || hour < 5) return "night";
    if (now.getDay() === 5 && hour >= 12) return "shades";
    if (hour >= 5 && hour < 12) return "coffee";
    return "";
  }

  // The first line of a reply is often just "Hi". Keep reading until the answer.
  function gist(text) {
    const clean = String(text || "").replace(/[#*_`]/g, "").replace(/\s+/g, " ").trim();
    if (!clean) return "";
    const parts = (clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean]).map((s) => s.trim()).filter(Boolean);
    let i = 0;
    if (parts.length > 1 && GREET.test(parts[0]) && parts[0].length < 40) i = 1;
    let out = "";
    for (; i < parts.length; i += 1) {
      const next = out ? `${out} ${parts[i]}` : parts[i];
      if (out && next.length > 160) break;
      out = next;
      if (out.length >= 80 && /[.!?]$/.test(out)) break;
    }
    if (out.length > 170) out = `${out.slice(0, 167).replace(/\s+\S*$/, "")}…`;
    return out;
  }

  function showBubble(text) {
    if (!on || !text) return;
    bubble.textContent = text;
    bubble.hidden = false;
    stage.classList.add("has-bubble");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => {
      bubble.hidden = true;
      stage.classList.remove("has-bubble");
    }, 8000);
  }

  function wake() {
    quietSince = Date.now();
    if (!asleep) return;
    asleep = false;
    stage.classList.remove("is-asleep");
    start("stretch");
  }

  function start(name) {
    if (!on || reduceMotion) return;
    if (name !== "plane" && name !== "shiver" && anim && (anim.name === "plane" || anim.name === "shiver")) {
      nextAnim = name;
      return;
    }
    anim = { name, i: 0 };
    stage.classList.add("is-celebrating");
    asleep = false;
    stage.classList.remove("is-asleep");
  }

  function finishAnim() {
    anim = null;
    stage.classList.remove("is-celebrating");
    if (!nextAnim) return;
    const name = nextAnim;
    nextAnim = "";
    start(name);
  }

  const BODY = new Set(["o", "l", "b", "d", "e", "w", "m", "p"]);
  function fatten(rows, n) {
    let current = rows.map((row) => row.split(""));
    for (let k = 0; k < n; k += 1) {
      const next = current.map((row) => row.slice());
      current.forEach((row, y) => {
        let first = -1;
        let last = -1;
        row.forEach((ch, x) => {
          if (!BODY.has(ch)) return;
          if (first < 0) first = x;
          last = x;
        });
        if (first < 0) return;
        if (first > 0) {
          next[y][first - 1] = row[first] === "o" ? "o" : "b";
          if (row[first] === "o") next[y][first] = "l";
        }
        if (last < W - 1) {
          next[y][last + 1] = row[last] === "o" ? "o" : "b";
          if (row[last] === "o") next[y][last] = "b";
        }
      });
      current = next;
    }
    return current.map((row) => row.join(""));
  }

  function stamp(grid, rows, ox, oy) {
    if (!rows) return;
    for (let y = 0; y < rows.length; y += 1) {
      for (let x = 0; x < rows[y].length; x += 1) {
        const ch = rows[y][x];
        if (ch === ".") continue;
        const nx = x + (ox || 0);
        const ny = y + (oy || 0);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        grid[ny][nx] = ch;
      }
    }
  }

  function emptyGrid() {
    return Array.from({ length: H }, () => Array(W).fill("."));
  }

  function workingNow() {
    const state = capsule.dataset.state || "idle";
    const activity = capsule.dataset.activity || "";
    return state === "thinking" || state === "connecting"
      || activity === "searching" || activity === "writing";
  }

  function calmNow() {
    const state = capsule.dataset.state || "idle";
    const activity = capsule.dataset.activity || "";
    return !anim && ["idle", "listening", "muted"].includes(state) && !activity;
  }

  function noteQuiet() {
    if (!calmNow()) {
      quietSince = Date.now();
      if (asleep) {
        asleep = false;
        stage.classList.remove("is-asleep");
      }
      return;
    }
    if (!asleep && Date.now() - quietSince >= QUIET_MS) {
      asleep = true;
      stage.classList.add("is-asleep");
    }
  }

  function chooseBody() {
    const step = anim ? ANIMS[anim.name][anim.i] || {} : null;
    if (step) return step;
    if (asleep) return { body: "sleep", z: true };
    if (petUntil > Date.now()) return { body: "pet" };
    const speaking = capsule.dataset.state === "speaking";
    if (speaking && tick % 4 < 2) return { body: "talk" };
    if (blinking > 0) return { body: "blink" };
    if (look === -1 || (look === 0 && glance > 0 && glanceDir < 0)) return { body: "lookL" };
    if (look === 1 || (look === 0 && glance > 0 && glanceDir > 0)) return { body: "lookR" };
    if (calmNow() && tick % 36 < 5 && outfitNow() !== "shades") return { body: "squash" };
    return { body: "idle" };
  }

  function addDots(grid, oy) {
    const which = Math.floor(tick / 3) % 3;
    for (let i = 0; i < 3; i += 1) {
      const x = 6 + i * 2;
      const y = (i === which ? 0 : 1) + (oy || 0);
      if (y >= 0 && y < H && x >= 0 && x < W) grid[y][x] = "t";
    }
  }

  function addPlane(grid, x) {
    const shape = ["a.a.", ".aa.", "a..."];
    shape.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx += 1) {
        if (row[dx] === ".") continue;
        const nx = x + dx;
        const ny = dy;
        if (nx >= 0 && nx < W && ny < H) grid[ny][nx] = "a";
      }
    });
  }

  function addSpark(grid) {
    [[1, 1], [14, 2], [1, 10], [14, 11]].forEach(([cx, cy]) => {
      [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dx, dy]) => {
        const x = cx + dx;
        const y = cy + dy;
        if (grid[y] && grid[y][x] === ".") grid[y][x] = "s";
      });
    });
  }

  function addZ(grid) {
    const x0 = 8 + (Math.floor(tick / 6) % 5);
    const shape = ["zz.", "..z", "zz."];
    shape.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx += 1) {
        if (row[dx] === ".") continue;
        const nx = x0 + dx;
        const ny = 6 + dy;
        if (nx >= 0 && nx < W && ny < H) grid[ny][nx] = "z";
      }
    });
  }

  function paint() {
    noteQuiet();
    if (!anim && calmNow() && !asleep && look === 0) {
      if (blinking > 0) blinking -= 1;
      else if (outfitNow() !== "shades") {
        blinkIn -= 1;
        if (blinkIn <= 0) {
          blinking = 2;
          blinkIn = 40 + Math.floor(Math.random() * 36);
        }
      }
      if (glance > 0) glance -= 1;
      else {
        glanceIn -= 1;
        if (glanceIn <= 0) {
          glance = 8;
          glanceDir = Math.random() < 0.5 ? -1 : 1;
          glanceIn = 28 + Math.floor(Math.random() * 40);
        }
      }
    }

    const step = chooseBody();
    const name = step.body || "idle";
    const grid = emptyGrid();
    const body = fatten(SPRITES[name] || idle, name === "splat" ? 0 : round);
    stamp(grid, body, step.ox || 0, step.oy || 0);
    const outfit = outfitNow();
    const coverEyes = name === "blink" || name === "sleep" || name === "wide" || name === "splat";
    if (outfit === "coffee") stamp(grid, (tick % 8 < 4 ? cupA : cupB), step.ox || 0, step.oy || 0);
    if (outfit === "night") stamp(grid, cap, step.ox || 0, step.oy || 0);
    if (outfit === "shades" && !coverEyes) stamp(grid, shades, step.ox || 0, step.oy || 0);
    if (!anim && workingNow()) addDots(grid, step.oy || 0);
    if (Number.isFinite(step.plane)) addPlane(grid, step.plane);
    if (step.spark) addSpark(grid);
    if (step.z) addZ(grid);

    const key = grid.map((row) => row.join("")).join("\n");
    if (key === lastKey) return;
    lastKey = key;
    const data = img.data;
    let p = 0;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const ink = PAL[grid[y][x]];
        if (!ink) {
          data[p] = 0; data[p + 1] = 0; data[p + 2] = 0; data[p + 3] = 0;
        } else {
          data[p] = ink[0]; data[p + 1] = ink[1]; data[p + 2] = ink[2]; data[p + 3] = ink[3];
        }
        p += 4;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function frame() {
    if (!on || document.hidden) return;
    tick += 1;
    try {
      paint();
    } catch (err) {
      console.error("Brain pet failed while drawing a frame:", err);
    }
    if (!anim) return;
    anim.i += 1;
    if (anim.i >= ANIMS[anim.name].length) finishAnim();
  }

  function startLoop() {
    if (timer || reduceMotion) return;
    timer = setInterval(frame, 1000 / 12);
  }

  function stopLoop() {
    clearInterval(timer);
    timer = 0;
  }

  function setOn(next) {
    if (next === on) return on;
    on = Boolean(next);
    if (!on) {
      stopLoop();
      anim = null;
      nextAnim = "";
      asleep = false;
      stage.classList.remove("is-celebrating", "is-asleep");
      bubble.hidden = true;
      stage.classList.remove("has-bubble");
      return false;
    }
    syncRound();
    quietSince = Date.now();
    lastKey = "";
    try {
      paint();
    } catch (err) {
      console.error("Brain pet failed while drawing the first frame:", err);
      on = false;
      return false;
    }
    startLoop();
    return true;
  }

  function onPetEvent(event) {
    if (!on) return;
    const kind = event.detail?.kind;
    try {
      if (kind === "sent") {
        if (Date.now() - sentAt < 1200) return;
        sentAt = Date.now();
        wake();
        bumpSnack();
        start("plane");
      } else if (kind === "fail") {
        wake();
        start("shiver");
      } else if (kind === "reply") {
        const text = String(event.detail?.text || "");
        showBubble(gist(text));
        if (PROUD.test(text)) start("hop");
      }
    } catch (err) {
      console.error("Brain pet failed while reacting:", err);
    }
  }

  window.addEventListener("brain-pet", onPetEvent);
  new MutationObserver(() => {
    if (!on) return;
    const activity = capsule.dataset.activity || "";
    if (activity && activity !== seenActivity) {
      seenActivity = activity;
      quietSince = Date.now();
      if (activity === "saved" || activity.startsWith("move-")) start("hop");
    }
    if (!activity) seenActivity = "";
    lastKey = "";
    if (reduceMotion) {
      try { paint(); } catch (err) {
        console.error("Brain pet failed while drawing a still frame:", err);
      }
    }
  }).observe(capsule, { attributes: true, attributeFilter: ["data-state", "data-activity"] });

  capsule.addEventListener("pointerenter", () => { if (on) wake(); });
  capsule.addEventListener("pointerleave", () => {
    look = 0;
    clearTimeout(restTimer);
  });
  capsule.addEventListener("pointermove", (event) => {
    if (!on) return;
    if (asleep) wake();
    quietSince = Date.now();
    const rect = canvas.getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    look = event.clientX < mid - 16 ? -1 : event.clientX > mid + 16 ? 1 : 0;
    if (Math.abs(event.clientX - restX) + Math.abs(event.clientY - restY) < 18) return;
    restX = event.clientX;
    restY = event.clientY;
    clearTimeout(restTimer);
    restTimer = setTimeout(() => {
      if (!on || anim || asleep) return;
      petUntil = Date.now() + 2000;
      const heart = document.createElement("span");
      heart.className = "brain-heart";
      heart.textContent = "♥";
      heart.addEventListener("animationend", () => heart.remove());
      stage.append(heart);
      lastKey = "";
    }, 700);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopLoop();
    else if (on) {
      lastKey = "";
      startLoop();
      try { paint(); } catch (err) {
        console.error("Brain pet failed while drawing after the window came back:", err);
      }
    }
  });

  syncRound();
  window.brainPet = { setOn };
})();
