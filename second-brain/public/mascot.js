/**
 * Tiny, the talking mascot (the Rive character from OpenHuman, GPL-3.0).
 *
 * It replaces the orb. It follows the capsule's data-state:
 *   thinking / connecting -> thinking pose
 *   speaking              -> mouth moves with the voice
 *   idle / listening      -> idle pose, a wave when a call starts
 * It also follows data-activity (set by voice.js), unless Tiny is speaking:
 *   searching -> reading a book, writing -> writing, saved -> celebration
 * When nothing happens for a while, Tiny does a little idle move now and then.
 * If the character cannot load, the orb stays.
 *
 * The .riv file holds a view model with two enums:
 *   pose            idle, thinking, celebration, hand_wave, bookreading, writing,
 *                   coffeedrink, bobbateadrink, dancing, recording
 *   mouthVisemeCode sil, PP, FF, TH, DD, kk, CH, SS, nn, RR, aa, E, ih, oh, ou
 */
(function startMascot() {
  const capsule = document.getElementById("capsule");
  const canvas = document.getElementById("mascotCanvas");
  if (!capsule || !canvas || !window.rive) return;

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

  rive.RuntimeLoader.setWasmUrl("/vendor/rive/rive.wasm");
  const tiny = new rive.Rive({
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
      capsule.classList.add("has-mascot");
      render();
      scheduleIdleMove(8000);
    },
    onLoadError: (err) => console.error("Failed while loading Tiny:", err),
  });

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
    if (state === "thinking" || state === "connecting") setPose("thinking");
    else if (state === "listening" && (lastState === "connecting" || lastState === "idle")) {
      // A call just started: wave hello, then settle.
      setPose("hand_wave");
      setTimeout(() => capsule.dataset.state === "listening" && render(), 2200);
    } else setPose("idle");
  }

  // An activity pose wins over thinking and idle, but not over speaking.
  function render() {
    const state = capsule.dataset.state;
    const pose = ACTIVITY_POSES[capsule.dataset.activity];
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
      if (quiet()) {
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
    render();
    lastState = state;
    lastActivity = activity;
    scheduleIdleMove(8000);
  }).observe(capsule, { attributes: true, attributeFilter: ["data-state", "data-activity"] });

  window.addEventListener("resize", () => tiny.resizeDrawingSurfaceToCanvas());
})();
