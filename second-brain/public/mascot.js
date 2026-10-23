/**
 * Tiny, the talking mascot (the Rive character from OpenHuman, GPL-3.0).
 *
 * It replaces the orb. It follows the capsule's data-state:
 *   thinking / connecting -> thinking pose
 *   speaking              -> mouth moves with the voice
 *   idle / listening      -> idle pose, a wave when a call starts
 * In a meeting, Tiny holds the recording pose.
 * It also follows data-activity (set by voice.js), unless Tiny is speaking:
 *   searching -> reading a book, writing -> writing, saved -> celebration
 * A move the user asked for ("move-dancing") wins even while Tiny speaks.
 * When nothing happens for a while, Tiny does a little idle move now and then.
 * If the character cannot load, the orb stays.
 *
 * Settings > Mascot picks Tiny or a pixel mascot: the Claude Code critter (the
 * default), a cat, a robot, Brain, or an emoji face. Brain is the pixel pet in
 * brainpet.js (it celebrates, shows a reply bubble, and dresses for the time
 * of day). The other pixel mascots are SVGs animated by CSS from the same
 * data-state and data-activity. Tiny's Rive file only loads once Tiny is picked.
 *
 * The .riv file holds a view model with two enums:
 *   pose            idle, thinking, celebration, hand_wave, bookreading, writing,
 *                   coffeedrink, bobbateadrink, dancing, recording
 *   mouthVisemeCode sil, PP, FF, TH, DD, kk, CH, SS, nn, RR, aa, E, ih, oh, ou
 */
(function startMascot() {
  const capsule = document.getElementById("capsule");
  const canvas = document.getElementById("mascotCanvas");
  const mark = document.getElementById("claudeMark");
  const select = document.getElementById("mascotSelect");
  if (!capsule || !canvas) return;

  // Mouth shapes to cycle through while speaking. Open vowels more often, so it reads as talking.
  const TALK_SHAPES = ["aa", "E", "oh", "ih", "aa", "ou", "DD", "SS", "aa", "E", "nn", "PP"];
  // Poses for what is happening, and the moves Tiny does when bored.
  const ACTIVITY_POSES = { searching: "bookreading", writing: "writing", saved: "celebration" };
  const IDLE_MOVES = ["coffeedrink", "bobbateadrink", "dancing"];
  let vm = null;
  let mouthTimer = 0;
  let idleTimer = 0;
  let lastState = capsule.dataset.state;
  let lastActivity = capsule.dataset.activity || "";
  let tiny = null;
  const CHOICES = ["claude", "cat", "robot", "brain", "emoji", "tiny"];
  const pick = (value) => (CHOICES.includes(value) ? value : "claude");
  let choice = pick(localStorage.getItem("mascot"));

  // The pixel mascots. Each uses the same parts (critter, arm, leg, eyes, mouth), so one set of
  // CSS animations in voice.css moves them all. The Claude Code critter is the default.
  const legs = (xs, y, w, h) => xs.map((x, i) =>
    `<rect class="leg" style="--i:${i}" x="${x}" y="${y}" width="${w}" height="${h}"/>`).join("");
  const eyes = (y, w, h, xs) => `<g class="eyes">${xs.map((x) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`).join("")}</g>`;
  const DRAWINGS = {
    // Square body, two arms, four legs, open eyes, a hidden mouth.
    claude: `<rect class="arm arm-l" x="35" y="140" width="52" height="105"/>
      <rect class="arm arm-r" x="513" y="140" width="52" height="105"/>
      ${legs([85, 180, 370, 465], 340, 50, 110)}
      <rect class="body" x="85" y="35" width="430" height="310"/>
      ${eyes(120, 40, 80, [160, 400])}
      <rect class="mouth" x="270" y="235" width="60" height="40"/>`,
    // The ears wave like arms; the tail flicks while it thinks.
    cat: `<rect class="tail" x="475" y="60" width="45" height="260"/>
      <rect class="arm arm-l" x="130" y="40" width="70" height="90"/>
      <rect class="arm arm-r" x="400" y="40" width="70" height="90"/>
      ${legs([140, 210, 340, 410], 340, 50, 100)}
      <rect class="body" x="120" y="110" width="360" height="250"/>
      ${eyes(170, 40, 60, [200, 360])}
      <rect class="mouth" x="275" y="260" width="50" height="30"/>`,
    // The antenna light blinks while it thinks or talks.
    robot: `<rect x="292" y="20" width="16" height="45"/>
      <rect class="bulb" x="275" y="0" width="50" height="30"/>
      <rect class="arm arm-l" x="40" y="150" width="60" height="110"/>
      <rect class="arm arm-r" x="500" y="150" width="60" height="110"/>
      ${legs([180, 370], 340, 50, 110)}
      <rect class="body" x="100" y="55" width="400" height="290"/>
      ${eyes(130, 70, 60, [170, 360])}
      <rect class="mouth" x="230" y="240" width="140" height="40"/>`,
    // Lumpy on top, a fold down the middle, small arms and legs.
    brain: `<rect class="arm arm-l" x="50" y="170" width="50" height="80"/>
      <rect class="arm arm-r" x="500" y="170" width="50" height="80"/>
      ${legs([200, 355], 310, 45, 110)}
      <rect x="140" y="30" width="100" height="40"/>
      <rect x="260" y="20" width="100" height="50"/>
      <rect x="380" y="30" width="90" height="40"/>
      <rect class="body" x="100" y="60" width="400" height="260"/>
      <rect class="fold" x="296" y="40" width="8" height="90"/>
      ${eyes(150, 40, 70, [200, 360])}
      <rect class="mouth" x="270" y="245" width="60" height="35"/>`,
    // One emoji; follow() swaps it with the state.
    emoji: `<text class="face" x="300" y="245" font-size="380" text-anchor="middle"
      dominant-baseline="central">🙂</text>`,
  };
  // The emoji for each state and activity. An activity wins, as with Tiny.
  const FACES = {
    idle: "🙂", listening: "😊", muted: "🤐", thinking: "🤔", connecting: "🤔",
    speaking: "😃", meeting: "🧐", lecture: "🧐",
    searching: "🔎", writing: "✍️", saved: "🥳", move: "🕺",
  };

  function draw() {
    if (!mark || choice === "tiny") return;
    mark.setAttribute("viewBox", "20 0 560 470");
    mark.dataset.mascot = choice;
    mark.innerHTML = `<g class="critter">${DRAWINGS[choice]}</g>`;
    showFace();
  }

  function showFace() {
    const face = choice === "emoji" && mark?.querySelector(".face");
    if (!face) return;
    const activity = capsule.dataset.activity || "";
    face.textContent = FACES[activity.startsWith("move-") ? "move" : activity]
      || FACES[capsule.dataset.state] || FACES.idle;
  }

  // A blink every 4-7 s: the eyes redraw for those few frames only.
  function blinkLater() {
    setTimeout(() => {
      if (!document.hidden) {
        mark.classList.add("blink");
        setTimeout(() => mark.classList.remove("blink"), 150);
      }
      blinkLater();
    }, 4000 + Math.random() * 3000);
  }
  if (mark) blinkLater();

  function applyChoice() {
    const brainOn = choice === "brain" && window.brainPet?.setOn(true);
    if (!brainOn) window.brainPet?.setOn(false);
    capsule.classList.toggle("is-brain", Boolean(brainOn));
    capsule.classList.toggle("is-claude", choice !== "tiny");
    if (choice !== "tiny") {
      if (!brainOn) draw();
      capsule.classList.toggle("has-mascot", Boolean(mark));
      stopMouth();
      tiny?.stopRendering?.();
      return;
    }
    if (!vm) {
      capsule.classList.remove("has-mascot");
      loadTiny();
      return;
    }
    capsule.classList.add("has-mascot");
    tiny.startRendering?.();
    tiny.resizeDrawingSurfaceToCanvas();
    render();
  }

  select?.addEventListener("change", () => {
    choice = pick(select.value);
    localStorage.setItem("mascot", choice);
    applyChoice();
  });
  if (select) select.value = choice;
  applyChoice();

  function loadTiny() {
    if (tiny || !window.rive) return;
    rive.RuntimeLoader.setWasmUrl("/vendor/rive/rive.wasm");
    tiny = new rive.Rive({
      src: "/mascot/tiny_mascot.riv",
      canvas,
      stateMachine: "MascotSM",
      autoplay: true,
      autoBind: true,
      layout: new rive.Layout({ fit: rive.Fit.Contain }),
      onLoad: () => {
        tiny.resizeDrawingSurfaceToCanvas();
        vm = tiny.viewModelInstance;
        if (!vm) {
          console.error("Tiny loaded without its view model; keeping the orb.");
          return;
        }
        if (choice === "tiny") applyChoice();
        scheduleIdleMove(8000);
      },
      onLoadError: (err) => console.error("Failed while loading Tiny:", err),
    });
  }

  function setPose(pose) {
    const input = vm?.enum("pose");
    if (input) input.value = pose;
  }

  function setMouth(code) {
    const input = vm?.enum("mouthVisemeCode");
    if (input) input.value = code;
  }

  function startMouth() {
    if (mouthTimer) return;
    mouthTimer = setInterval(() => {
      setMouth(TALK_SHAPES[Math.floor(Math.random() * TALK_SHAPES.length)]);
    }, 95);
  }

  function stopMouth() {
    clearInterval(mouthTimer);
    mouthTimer = 0;
    setMouth("sil");
  }

  function follow(state) {
    if (state === "speaking") {
      setPose("idle");
      startMouth();
      return;
    }
    stopMouth();
    if (state === "meeting" || state === "lecture") setPose("recording");
    else if (state === "thinking" || state === "connecting") setPose("thinking");
    else if (state === "listening" && (lastState === "connecting" || lastState === "idle")) {
      // A call just started: wave hello, then settle.
      setPose("hand_wave");
      setTimeout(() => capsule.dataset.state === "listening" && render(), 2200);
    } else setPose("idle");
  }

  // An activity pose wins over thinking and idle, but not over speaking.
  function render() {
    const state = capsule.dataset.state;
    const activity = capsule.dataset.activity || "";
    if (activity.startsWith("move-")) {
      stopMouth();
      setPose(activity.slice(5));
      return;
    }
    const pose = ACTIVITY_POSES[activity];
    if (pose && state !== "speaking") {
      stopMouth();
      setPose(pose);
    } else follow(state);
  }

  function quiet() {
    return capsule.dataset.state === "idle" && !capsule.dataset.activity;
  }

  // After a quiet spell, a little move every 20 to 40 seconds. Never during a call.
  function scheduleIdleMove(delay) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (quiet() && choice === "tiny") {
        setPose(IDLE_MOVES[Math.floor(Math.random() * IDLE_MOVES.length)]);
        setTimeout(() => quiet() && setPose("idle"), 5000);
      }
      scheduleIdleMove(20000 + Math.random() * 20000);
    }, delay);
  }

  new MutationObserver(() => {
    const state = capsule.dataset.state;
    const activity = capsule.dataset.activity || "";
    if (state === lastState && activity === lastActivity) return;
    if (choice === "tiny") render();
    else showFace();
    lastState = state;
    lastActivity = activity;
    scheduleIdleMove(8000);
  }).observe(capsule, { attributes: true, attributeFilter: ["data-state", "data-activity"] });

  window.addEventListener("resize", () => tiny?.resizeDrawingSurfaceToCanvas());
})();

// Hidden window: pause every CSS animation (voice.css, html.page-hidden).
document.addEventListener("visibilitychange", () => {
  document.documentElement.classList.toggle("page-hidden", document.hidden);
});
