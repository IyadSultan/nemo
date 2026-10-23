/**
 * Turns a spoken movie order into a small object the editor can run.
 * The page and the server both load this file, so they agree on every phrase.
 *
 * OpenCut (https://github.com/opencut-app/opencut) is rewriting its editor in Rust.
 * That rewrite has no editor to call yet. These phrases drive moviecut, the Rust
 * timeline in this app.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else {
    root.parseMovieOrder = api.parseMovieOrder;
    root.MOVIE_ORDERS = api.MOVIE_ORDERS;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  // Every phrase in this list works from the main chat. You do not have to
  // open the panel first. Shorter versions work once the panel is open.
  const MOVIE_ORDERS = [
    { say: "Open the movie editor", does: "Shows the movie panel, with this list of orders." },
    { say: "Close the movie editor", does: "Hides the panel and shows the transcript again." },
    { say: "New movie called trip", does: "Starts a movie named trip, or opens it if that name already exists." },
    { say: "Add the video birthday", does: "Finds one video with that name in Movies, Desktop, Downloads, or Documents." },
    { say: "Add the video on the Desktop called birthday", does: "Looks only on the Desktop." },
    { say: "Add the photo beach to the movie", does: "Finds one photo with that name, HEIC too, and shows it for 4 seconds. Also looks in Pictures." },
    { say: "Add the photo on the Downloads called beach to the movie", does: "Looks only in Downloads. With the panel open you can leave off “to the movie”." },
    { say: "Cut the first 3 seconds of the movie", does: "Drops the opening." },
    { say: "Cut the last 2 seconds of the movie", does: "Drops the ending." },
    { say: "Keep from 10 seconds to 40 seconds of the movie", does: "Keeps only that part." },
    { say: "Remove from 1 minute to 1 minute 20 seconds of the movie", does: "Cuts that piece out and joins what is left." },
    { say: "Split the movie at 15 seconds", does: "Makes two clips at that moment." },
    { say: "Drop clip 2", does: "Removes the second clip. Say drop the last clip for the last one." },
    { say: "Speed the movie up twice", does: "Plays the whole movie at double speed." },
    { say: "Slow the movie down to half", does: "Plays the whole movie at half speed." },
    { say: "Set the movie speed to 1.5", does: "Sets the speed. 1 is normal. The fastest is 4. The slowest is a quarter." },
    { say: "Mute the movie", does: "Turns the sound off." },
    { say: "Unmute the movie", does: "Turns the sound back on." },
    { say: "Set the movie volume to 80 percent", does: "Sets how loud it is. Half means 50 percent. 100 is normal. 200 is the loudest." },
    { say: "Fade the movie in", does: "The picture fades up over 1 second." },
    { say: "Fade the movie out", does: "The picture fades away at the end, over 1 second." },
    { say: "Fade the movie in for 2 seconds", does: "Same fade, for the length you say." },
    { say: "Add a caption saying hello from 2 seconds to 5 seconds", does: "Writes those words on the picture between those times." },
    { say: "Remove the captions from the movie", does: "Clears every caption." },
    { say: "Rotate clip 2 right", does: "Turns that clip a quarter turn. Say left, or upside down. Rotate the last clip works too." },
    { say: "Add crossfades between the clips", does: "Every cut blends into the next. Also: slide, wipe, circle, zoom, dip to black, dip to white, or random for a different one at each cut." },
    { say: "Make the transitions 2 seconds", does: "Sets how long each transition takes. Say no transitions to go back to straight cuts." },
    { say: "Zoom the photos", does: "Photos push in slowly while they show. Say keep the photos still to stop." },
    { say: "Make music for the movie", does: "Writes a new piece to fit the movie's theme: online with Gemini Lyria, or on this Mac with MusicGen. Add a mood: make calm piano music for the movie, or make music like a seaside holiday." },
    { say: "Add the music sunny", does: "Finds a song in Music, Downloads, Desktop, or Documents and plays it under the movie. It dips when people talk." },
    { say: "Set the music volume to 20 percent", does: "Music level. Say remove the music to take it out." },
    { say: "Caption the movie", does: "Listens to the speech and writes captions with their times. It replaces the captions there were." },
    { say: "Add a title card saying Rome in October", does: "Makes a 4 second animated title at the start. Add: with the subtitle family trip. Say at the end to put it last." },
    { say: "Redo the movie", does: "Puts back the step you just undid." },
    { say: "Make the movie portrait", does: "Phone shape, 1080 by 1920. Also square, widescreen, or classic." },
    { say: "Set the movie background to blue", does: "Colour behind clips that do not fill the frame. Say blur the background to fill the bars with a soft copy of the clip." },
    { say: "Move clip 2 left", does: "Slides that clip. Also right, up, down, or to the center." },
    { say: "Make clip 2 smaller", does: "Shrinks it. Also bigger, half size, or 70 percent size." },
    { say: "Stretch clip 2 wide", does: "Stretches the shape. Also tall, or back to normal." },
    { say: "Make clip 2 half see through", does: "Or say make clip 2 solid. Set clip 2 opacity to 40 percent works too." },
    { say: "Mute clip 2", does: "Turns off that clip's sound only. Unmute clip 2 turns it back on." },
    { say: "Set clip 2 volume to 40 percent", does: "That clip only. The movie volume still applies on top." },
    { say: "Speed clip 2 up twice", does: "That clip only. Also slow clip 2 to half, or set clip 2 speed to 1.5." },
    { say: "Hide clip 2", does: "The clip stays in its place, but the picture and sound are off. Show clip 2 brings it back." },
    { say: "Duplicate clip 2", does: "Plays that clip twice in a row." },
    { say: "Move clip 2 to the start", does: "Also: to the end, earlier, later, or move clip 7 before clip 3 (or after). You can also drag a clip along the timeline." },
    { say: "Blur clip 2", does: "Softens that clip. Blur clip 2 more goes further. Unblur clip 2 makes it sharp." },
    { say: "Put a circle mask on clip 2", does: "The clip shows inside a circle. Remove the mask from clip 2 clears it." },
    { say: "Add cinema bars", does: "Black bars at the top and bottom. Remove the cinema bars takes them off." },
    { say: "Blend clip 2 with multiply", does: "Mixes the clip with the background. Also screen or overlay. Remove the blend from clip 2 clears it." },
    { say: "Zoom clip 2", does: "That clip pushes in slowly. Stop zooming clip 2 keeps it still." },
    { say: "Make the captions yellow", does: "Also bigger or smaller. The colour is white, yellow, blue, and the other background colours." },
    { say: "Add the subtitles birthday", does: "Finds an srt file with that name and uses it as the captions." },
    { say: "Reset the look of clip 2", does: "Size, place, blur, mask, and see-through go back to normal. The cut stays." },
    { say: "Show the grid", does: "A guide on the preview. It is not in the exported movie. Also show the phone guide, or hide the guides." },
    { say: "Bookmark at 10 seconds", does: "Marks that moment. With the panel open, bookmark here uses the playhead. Go to the bookmark jumps there." },
    { say: "What is in the movie", does: "Says the clips and the length." },
    { say: "How long is the movie", does: "Says the length." },
    { say: "Export the movie", does: "Makes an mp4 in your Movies folder." },
    { say: "Make the movie", does: "Same as export the movie." },
    { say: "Start the movie over", does: "Clears the clips and captions. Undo can bring them back." },
    { say: "Movie orders", does: "Opens the panel so you can read this list." },
  ];

  const WORD_NUMBERS = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
  };
  const NUM = "(?:\\d+(?:\\.\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|ninety)";
  const ORDINALS = {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: 0,
  };

  /** Lower case, one space, Hey and please removed. Keeps times like 1:20. */
  function norm(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s:./~%-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
      // Speech to text ends sentences with a full stop. Numbers like 1.5 keep theirs.
      .replace(/\.+$/, "")
      .trim()
      .replace(/^(?:please |hey )+/, "");
  }

  function wordNumber(token) {
    if (token == null) return null;
    if (/^\d/.test(token)) {
      const value = Number(token);
      return Number.isFinite(value) ? value : null;
    }
    return Object.prototype.hasOwnProperty.call(WORD_NUMBERS, token) ? WORD_NUMBERS[token] : null;
  }

  /** The whole string must be one length of time, such as "3 seconds" or "1:20". */
  function parseTimeExact(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    const clock = text.match(/^(\d+):(\d{1,2})$/);
    if (clock) {
      const seconds = Number(clock[2]);
      if (seconds >= 60) return null;
      return Number(clock[1]) * 60 + seconds;
    }
    if (text === "half a minute") return 30;
    if (text === "half a second") return 0.5;
    let match = text.match(new RegExp(`^(${NUM}) minutes?(?: and)? (${NUM}) seconds?$`));
    if (match) {
      const minutes = wordNumber(match[1]);
      const seconds = wordNumber(match[2]);
      if (minutes == null || seconds == null) return null;
      return minutes * 60 + seconds;
    }
    match = text.match(new RegExp(`^(${NUM}) minutes?$`));
    if (match) {
      const minutes = wordNumber(match[1]);
      return minutes == null ? null : minutes * 60;
    }
    match = text.match(new RegExp(`^(${NUM}) seconds?$`));
    if (match) return wordNumber(match[1]);
    return null;
  }

  /**
   * A typed path keeps its capitals, underscores and brackets. norm() would drop
   * them, and then the file is not found. Path orders come from the Ask box.
   */
  function keepPath(order, text) {
    if (!/^[/~]/.test(order.query || "")) return order;
    const match = String(text || "").trim().match(/(?:^|\s)((?:~\/|\/)[^\n]*?)(?:\s+(?:to|of|in) the movie)?[.!?]?$/i);
    return match ? { ...order, query: match[1] } : order;
  }

  /**
   * @param {string} text What the person said, after Hey.
   * @param {boolean} panelOpen When the movie panel is open, shorter phrases count too.
   * @returns {object|null} The order, or null when this sentence is not a movie order.
   */
  function parseMovieOrder(text, panelOpen) {
    const full = norm(text);
    if (!full) return null;
    // "of the movie" can sit on the end of a cut. The checks below see both forms.
    const q = full.replace(/ (?:of|from|in) the (?:movie|video|film)$/, "");
    const open = Boolean(panelOpen);

    if (/^(?:open|show|start)(?: the)? movie editor$/.test(full) || full === "edit the movie" || full === "open the movie") {
      return { op: "open" };
    }
    if (/^(?:close|hide)(?: the)? movie editor$/.test(full) || full === "close the movie") return { op: "close" };
    if (open && /^(?:close|close it|done)$/.test(full)) return { op: "close" };

    if (/^(?:movie orders|show movie orders|list(?: the)? movie orders|what are the movie orders)$/.test(full)) {
      return { op: "orders" };
    }

    let match = full.match(/^(?:new movie|start a movie) (?:called |named )?(.+)$/);
    if (match && match[1] !== "over") return { op: "new", name: match[1] };

    if (full === "start the movie over" || full === "clear the movie" || (open && full === "start over")) {
      return { op: "clear" };
    }

    match = full.match(/^add the video on the (desktop|downloads|movies|documents|pictures)(?: folder)? called (.+)$/);
    if (match) return { op: "add", folder: match[1], query: match[2] };
    match = q.match(/^add the video (.+)$/);
    if (match && !/^on the /.test(match[1])) return keepPath({ op: "add", query: match[1] }, text);

    // Photos need "to the movie" from the main chat, so other photo talk is left alone.
    const photo = full.match(/^add the (?:photo|picture|image) (.+?)(?: to the movie)?$/);
    if (photo && (open || / to the movie$/.test(full))) {
      const where = photo[1].match(/^on the (desktop|downloads|movies|documents|pictures)(?: folder)? called (.+)$/);
      if (where) return { op: "add", kind: "photo", folder: where[1], query: where[2] };
      if (!/^on the /.test(photo[1])) return keepPath({ op: "add", kind: "photo", query: photo[1] }, text);
    }
    if (open && /^(?:add this video|use this video)$/.test(full)) return { op: "add", picked: true };

    if (full === "what is in the movie" || full === "whats in the movie" || full === "how long is the movie") {
      return { op: "status" };
    }
    if (open && /^(?:what is in it|how long is it)$/.test(full)) return { op: "status" };

    if (full === "export the movie" || full === "make the movie" || (open && /^(?:export it|export)$/.test(full))) {
      return { op: "export" };
    }

    if (full === "undo the movie" || (open && /^(?:undo|undo that|undo that cut)$/.test(full))) return { op: "undo" };

    if (full === "mute the movie" || (open && /^(?:mute|mute it)$/.test(full))) return { op: "mute" };
    if (full === "unmute the movie" || (open && /^(?:unmute|unmute it)$/.test(full))) return { op: "unmute" };

    match = full.match(/^set the movie volume to (.+)$/) || (open ? full.match(/^set the volume to (.+)$/) : null);
    if (match) {
      const level = volumeLevel(match[1]);
      if (level == null) return { op: "error", error: "Say a volume from 0 to 200 percent, or say half." };
      return { op: "volume", level };
    }

    if (/^(?:remove|clear) the captions(?: from the movie)?$/.test(full)) return { op: "clear_captions" };

    const caption = captionOrder(full);
    if (caption) return caption;

    const fade = fadeOrder(full, open);
    if (fade) return fade;

    const speed = speedOrder(full, open);
    if (speed) return speed;

    match = q.match(/^(?:cut|trim) the first (.+)$/);
    if (match && (open || full !== q)) {
      const seconds = parseTimeExact(match[1]);
      if (seconds == null) return null;
      return { op: "cut_start", seconds };
    }
    match = q.match(/^(?:cut|trim) the last (.+)$/);
    if (match && (open || full !== q)) {
      const seconds = parseTimeExact(match[1]);
      if (seconds == null) return null;
      return { op: "cut_end", seconds };
    }

    match = q.match(/^keep from (.+?) to (.+)$/);
    if (match && (open || full !== q)) {
      const from = parseTimeExact(match[1]);
      const to = parseTimeExact(match[2]);
      if (from == null || to == null) return null;
      return { op: "keep", from, to };
    }
    match = q.match(/^remove from (.+?) to (.+)$/);
    if (match && (open || full !== q)) {
      const from = parseTimeExact(match[1]);
      const to = parseTimeExact(match[2]);
      if (from == null || to == null) return null;
      return { op: "remove", from, to };
    }

    match = full.match(/^split the movie at (.+)$/) || (open ? q.match(/^split at (.+)$/) : null);
    if (match) {
      const at = parseTimeExact(match[1]);
      if (at == null) return null;
      return { op: "split", at };
    }

    const feature = featureOrder(full, open, text);
    if (feature) return feature;

    const look = lookOrder(full, open, text);
    if (look) return look;

    match = full.match(/^drop clip (\d+)$/) || full.match(/^remove clip (\d+)$/);
    if (match) return { op: "drop", clip: Number(match[1]) };
    match = full.match(/^(?:drop|remove) the (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last) clip$/);
    if (match) return { op: "drop", clip: ORDINALS[match[1]] };

    return null;
  }

  const TRANSITION_WORDS = {
    crossfade: "crossfade", crossfades: "crossfade", "cross fade": "crossfade", "cross fades": "crossfade",
    fade: "crossfade", fades: "crossfade", dissolve: "crossfade", dissolves: "crossfade",
    slide: "slide", slides: "slide", wipe: "wipe", wipes: "wipe",
    circle: "circle", circles: "circle", zoom: "zoom", zooms: "zoom",
    random: "random", mixed: "random", different: "random",
  };

  /** Rotation, transitions, photo zoom, music, captions from speech, and title cards. */
  function featureOrder(full, open, text) {
    // Rotate clip 2 right / rotate the last clip left / turn clip 3 upside down.
    let match = full.match(/^(?:rotate|turn) (?:clip (\d+)|the (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last) (?:clip|photo|video))(?: to the| to)? ?(right|left|upside down|around)?$/);
    if (match) {
      const clip = match[1] ? Number(match[1]) : ORDINALS[match[2]];
      const way = match[3] || "right";
      const degrees = way === "left" ? -90 : way === "right" ? 90 : 180;
      return { op: "rotate", clip, degrees };
    }
    if (open) {
      match = full.match(/^(?:rotate|turn) it(?: to the| to)? ?(right|left|upside down|around)?$/);
      if (match) {
        const way = match[1] || "right";
        return { op: "rotate", clip: 0, degrees: way === "left" ? -90 : way === "right" ? 90 : 180 };
      }
    }

    // Transitions.
    if (/^(?:no|remove the|remove all|take out the) transitions(?: from the movie)?$/.test(full) || full === "use straight cuts") {
      return { op: "transition", kind: "none" };
    }
    match = full.match(/^dip to (black|white)(?: between(?: the)? clips)?$/);
    if (match && (open || / between/.test(full))) return { op: "transition", kind: match[1] };
    match = full.match(/^(?:add|use|put) (?:a |an )?(cross fades?|crossfades?|fades?|dissolves?|slides?|wipes?|circles?|zooms?|random|mixed|different)(?: transitions?)?(?: between(?: the)? clips| to the movie)?$/);
    if (match && (open || / between| to the movie|transition/.test(full))) {
      return { op: "transition", kind: TRANSITION_WORDS[match[1]] };
    }
    match = full.match(/^make the transitions (.+?)(?: long)?$/);
    if (match) {
      const seconds = parseTimeExact(match[1]);
      if (seconds == null) return { op: "error", error: "Say how long, such as make the transitions 1 second." };
      return { op: "transition", kind: "same", seconds };
    }

    // Photo zoom.
    if (/^(?:zoom the photos|make the photos zoom|zoom in on the photos)$/.test(full)) return { op: "photo_zoom", on: true };
    if (/^(?:keep the photos still|stop zooming the photos|do not zoom the photos|dont zoom the photos)$/.test(full)) {
      return { op: "photo_zoom", on: false };
    }

    // Music written for the movie. The mood is whatever sits around the word music.
    // "offline", "online", "locally", or "on this Mac" anywhere picks the engine.
    const engine = /\b(?:offline|locally|on (?:this|my) mac)\b/.test(full) ? "local" : /\bonline\b/.test(full) ? "online" : "auto";
    const plain = full.replace(/\b(?:offline|online|locally|on (?:this|my) mac)\b/g, " ").replace(/\s+/g, " ").trim();
    match = plain.match(/^(?:make|generate|compose|create|write) (?:me )?(?:some |the |a |new )?(.*?)(?:music|soundtrack|a song|background music)(?: for (?:the|this|my) movie)?(?: (?:like|about|that (?:sounds|feels) like|in the style of|that is) (.+))?$/);
    if (match && (open || / for (?:the|this|my) movie/.test(plain) || /soundtrack/.test(plain))) {
      const mood = [match[1], match[2]].map((part) => String(part || "").trim()).filter(Boolean).join(", ");
      return { op: "make_music", mood, engine };
    }

    // Music.
    if (/^(?:remove|take out|stop) the music$/.test(full) || full === "no music") return { op: "no_music" };
    match = full.match(/^set the music(?: volume)? to (.+)$/);
    if (match) {
      const level = volumeLevel(match[1]);
      if (level == null || level > 1) return { op: "error", error: "Say a music volume from 0 to 100 percent." };
      return { op: "music_volume", level };
    }
    match = full.match(/^(?:add|use|play) the (?:music|song) (.+?)(?: (?:to|in|under) the movie)?$/);
    if (match) return keepPath({ op: "music", query: match[1] }, text);

    // Captions from the speech.
    if (/^(?:caption the movie|auto caption the movie|add captions automatically|write the captions|write captions from the speech|add captions from the speech)$/.test(full)) {
      return { op: "auto_captions" };
    }
    if (open && /^(?:caption it|auto caption|add captions)$/.test(full)) return { op: "auto_captions" };

    // Title cards keep the words as typed or heard, with their capitals.
    if (/^add a title(?: card)?(?: at the (?:start|end|beginning))? (?:saying|called) /.test(full)) {
      const raw = String(text || "").trim().replace(/[.!?]+$/, "");
      const found = raw.match(/\b(?:saying|called)\s+(.+?)(?:\s+with the subtitle\s+(.+))?$/i);
      const title = (found?.[1] || "").trim();
      if (!title) return { op: "error", error: "Say the words, such as add a title card saying Rome in October." };
      if (title.length > 60) return { op: "error", error: "That title is too long. Keep it under 60 letters." };
      return { op: "title", title, subtitle: (found?.[2] || "").trim(), first: !/ at the end /.test(full) };
    }
    return null;
  }

  const CLIP = "clip (\\d+)|the (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last) clip";

  function clipOf(match) {
    return match[1] ? Number(match[1]) : ORDINALS[match[2]];
  }

  /**
   * Frame size, moving and resizing a clip, see-through, blur, masks,
   * per-clip sound and speed, redo, subtitles, and the preview guides.
   */
  function lookOrder(full, open, text) {
    if (full === "redo the movie" || (open && /^(?:redo|redo that)$/.test(full))) return { op: "redo" };

    let match = full.match(/^make the movie (widescreen|landscape|portrait|a phone movie|phone|square|classic|4 by 3)$/);
    if (match) {
      const kind = { landscape: "widescreen", phone: "portrait", "a phone movie": "portrait", "4 by 3": "classic" }[match[1]] || match[1];
      return { op: "frame", kind };
    }

    match = full.match(/^set the (?:movie )?background to ([a-z ]+)$/);
    if (match && (open || /movie background/.test(full))) return { op: "background", color: match[1].trim() };
    if (/^(?:blur|soften) the background$/.test(full)) return { op: "blur_background", on: true };
    if (/^(?:stop blurring the background|sharp background|flat background)$/.test(full)) return { op: "blur_background", on: false };

    match = full.match(new RegExp(`^move (?:${CLIP}) (left|right|up|down|to the center)$`));
    if (match) return { op: "nudge", clip: clipOf(match), way: match[3] === "to the center" ? "center" : match[3] };

    match = full.match(new RegExp(`^make (?:${CLIP}) (bigger|smaller|half size|normal size)$`));
    if (match) {
      const how = match[3] === "half size" ? "half" : match[3] === "normal size" ? "normal" : match[3];
      return { op: "scale", clip: clipOf(match), how };
    }
    match = full.match(new RegExp(`^make (?:${CLIP}) (${NUM}) percent size$`));
    if (match) {
      const scale = wordNumber(match[3]);
      if (scale == null) return { op: "error", error: "Say a size from 25 percent to 200 percent." };
      return { op: "scale", clip: clipOf(match), scale: scale / 100 };
    }

    match = full.match(new RegExp(`^stretch (?:${CLIP}) (wide|tall|back to normal|back)$`));
    if (match) return { op: "stretch", clip: clipOf(match), how: match[3] === "back" || match[3] === "back to normal" ? "normal" : match[3] };

    match = full.match(new RegExp(`^make (?:${CLIP}) (half see through|see through|solid)$`));
    if (match) {
      const level = match[3] === "solid" ? 1 : match[3] === "half see through" ? 0.5 : 0.4;
      return { op: "opacity", clip: clipOf(match), level };
    }
    match = full.match(new RegExp(`^set (?:${CLIP}) opacity to (.+)$`));
    if (match) {
      const level = volumeLevel(match[3]);
      if (level == null || level > 1) return { op: "error", error: "Say an opacity from 0 to 100 percent." };
      return { op: "opacity", clip: clipOf(match), level };
    }

    match = full.match(new RegExp(`^(mute|unmute) (?:${CLIP})$`));
    if (match) return { op: "clip_mute", clip: match[2] ? Number(match[2]) : ORDINALS[match[3]], muted: match[1] === "mute" };

    match = full.match(new RegExp(`^set (?:${CLIP}) volume to (.+)$`));
    if (match) {
      const level = volumeLevel(match[3]);
      if (level == null) return { op: "error", error: "Say a clip volume from 0 to 200 percent." };
      return { op: "clip_volume", clip: clipOf(match), level };
    }

    match = full.match(new RegExp(`^speed (?:${CLIP}) up twice$`));
    if (match) return { op: "clip_speed", clip: clipOf(match), rate: 2 };
    match = full.match(new RegExp(`^slow (?:${CLIP})(?: down)? to half$`));
    if (match) return { op: "clip_speed", clip: clipOf(match), rate: 0.5 };
    match = full.match(new RegExp(`^set (?:${CLIP}) speed to (.+)$`));
    if (match) {
      const rate = speedNumber(match[3]);
      if (rate == null) return { op: "error", error: "Say a clip speed such as twice, half, or 1.5." };
      return { op: "clip_speed", clip: clipOf(match), rate };
    }

    match = full.match(new RegExp(`^(hide|show) (?:${CLIP})$`));
    if (match) return { op: "hide", clip: match[2] ? Number(match[2]) : ORDINALS[match[3]], hidden: match[1] === "hide" };

    match = full.match(new RegExp(`^duplicate (?:${CLIP})$`));
    if (match) return { op: "duplicate", clip: clipOf(match) };

    match = full.match(new RegExp(`^move (?:${CLIP}) to the (start|end|beginning|front|back)$`));
    if (match) return { op: "move_clip", clip: clipOf(match), place: { beginning: "start", front: "start", back: "end" }[match[3]] || match[3] };
    match = full.match(new RegExp(`^move (?:${CLIP}) (?:one (?:step|place|clip) )?(earlier|later)$`));
    if (match) return { op: "move_clip", clip: clipOf(match), place: match[3] };
    match = full.match(new RegExp(`^move (?:${CLIP}) (before|after) clip (\\d+)$`));
    if (match) return { op: "move_clip", clip: clipOf(match), place: match[3], target: Number(match[4]) };

    match = full.match(new RegExp(`^blur (?:${CLIP}) more$`));
    if (match) return { op: "blur_clip", clip: clipOf(match), amount: -1 };
    match = full.match(new RegExp(`^(blur|unblur) (?:${CLIP})$`));
    if (match) return { op: "blur_clip", clip: match[2] ? Number(match[2]) : ORDINALS[match[3]], amount: match[1] === "unblur" ? 0 : 8 };

    match = full.match(new RegExp(`^(?:put|add) a circle mask on (?:${CLIP})$`));
    if (match) return { op: "mask", clip: clipOf(match), kind: "circle" };
    match = full.match(new RegExp(`^remove the mask from (?:${CLIP})$`));
    if (match) return { op: "mask", clip: clipOf(match), kind: "none" };

    if (full === "add cinema bars" || full === "add the cinema bars") return { op: "bars", on: true };
    if (/^remove the cinema bars$/.test(full)) return { op: "bars", on: false };

    match = full.match(new RegExp(`^blend (?:${CLIP}) with (multiply|screen|overlay)$`));
    if (match) return { op: "blend", clip: clipOf(match), kind: match[3] };
    match = full.match(new RegExp(`^remove the blend from (?:${CLIP})$`));
    if (match) return { op: "blend", clip: clipOf(match), kind: "none" };

    match = full.match(new RegExp(`^(zoom|stop zooming) (?:${CLIP})$`));
    if (match) return { op: "zoom_clip", clip: match[2] ? Number(match[2]) : ORDINALS[match[3]], on: match[1] === "zoom" };

    match = full.match(/^make the captions (bigger|smaller|normal|white|black|blue|red|green|yellow|orange|pink|purple|gray|grey|navy|teal)$/);
    if (match) {
      const word = match[1];
      if (word === "bigger" || word === "smaller" || word === "normal") return { op: "caption_style", size: word, color: "" };
      return { op: "caption_style", color: word, size: "" };
    }

    match = full.match(/^(?:add|use) the subtitles (.+)$/);
    if (match) return keepPath({ op: "subtitles", query: match[1] }, text);

    match = full.match(new RegExp(`^reset the look of (?:${CLIP})$`));
    if (match) return { op: "reset_look", clip: clipOf(match) };

    if (full === "show the grid") return { op: "guide", kind: "grid" };
    if (full === "show the phone guide") return { op: "guide", kind: "phone" };
    if (full === "hide the guides") return { op: "guide", kind: "none" };

    match = full.match(/^bookmark at (.+)$/);
    if (match) {
      const at = parseTimeExact(match[1]);
      if (at == null) return { op: "error", error: "Say when, such as bookmark at 10 seconds." };
      return { op: "bookmark", at };
    }
    if (open && /^(?:bookmark here|bookmark this moment)$/.test(full)) return { op: "bookmark_here" };
    if (/^(?:go to the bookmark|go to bookmark)$/.test(full)) return { op: "go_bookmark" };
    if (/^remove the bookmarks$/.test(full)) return { op: "clear_bookmarks" };

    if (open && /^(?:step|go) forward one frame$/.test(full)) return { op: "step", frames: 1 };
    if (open && /^(?:step|go) back one frame$/.test(full)) return { op: "step", frames: -1 };

    return null;
  }

  function volumeLevel(raw) {
    const text = String(raw || "").trim();
    if (text === "half") return 0.5;
    if (text === "full" || text === "normal") return 1;
    const match = text.match(new RegExp(`^(${NUM})(?: percent| %)?$`));
    if (!match) return null;
    const number = wordNumber(match[1]);
    if (number == null) return null;
    // "80" and "80 percent" both mean 80%. "1" alone would be 1%, so a bare 1 means full volume.
    if (!/percent|%/.test(text) && number > 0 && number <= 2) return number;
    return number / 100;
  }

  function fadeOrder(full, open) {
    const namedIn = full.match(/^fade the movie in(?: for (.+))?$/);
    const namedOut = full.match(/^fade the movie out(?: for (.+))?$/);
    const shortIn = open ? full.match(/^fade in(?: for (.+))?$/) : null;
    const shortOut = open ? full.match(/^fade out(?: for (.+))?$/) : null;
    const inn = namedIn || shortIn;
    const out = namedOut || shortOut;
    if (!inn && !out) return null;
    const tail = (inn || out)[1];
    let seconds = 1;
    if (tail) {
      seconds = parseTimeExact(tail);
      if (seconds == null) return { op: "error", error: "Say how long the fade is, such as fade the movie in for 2 seconds." };
    }
    return { op: inn ? "fade_in" : "fade_out", seconds };
  }

  function speedOrder(full, open) {
    if (full === "set the movie speed to normal" || full === "normal movie speed" || (open && full === "normal speed")) {
      return { op: "speed", rate: 1 };
    }
    let match = full.match(/^set the movie speed to (.+)$/) || (open ? full.match(/^set the speed to (.+)$/) : null);
    if (match) {
      const rate = speedNumber(match[1]);
      if (rate == null) return { op: "error", error: "Say a speed such as twice, half, or 1.5." };
      return { op: "speed", rate };
    }
    if (/^(?:speed the movie up twice|double the movie speed|play the movie twice as fast)$/.test(full)) return { op: "speed", rate: 2 };
    if (open && /^(?:speed it up(?: twice)?|speed up twice|double the speed|twice as fast)$/.test(full)) return { op: "speed", rate: 2 };
    match = full.match(/^speed the movie up (.+) times$/) || (open ? full.match(/^speed it up (.+) times$/) : null);
    if (match) {
      const rate = speedNumber(match[1]);
      if (rate == null) return { op: "error", error: "Say how many times faster, from a quarter to 4." };
      return { op: "speed", rate };
    }
    if (/^(?:slow the movie down(?: to half)?|play the movie at half speed)$/.test(full)) return { op: "speed", rate: 0.5 };
    if (open && /^(?:slow it down(?: to half)?|half speed|half as fast)$/.test(full)) return { op: "speed", rate: 0.5 };
    return null;
  }

  function speedNumber(raw) {
    const text = String(raw || "").trim();
    if (text === "normal" || text === "full") return 1;
    if (text === "half") return 0.5;
    if (text === "twice" || text === "double") return 2;
    if (text === "a quarter" || text === "quarter") return 0.25;
    return wordNumber(text);
  }

  /** "saying hello from the lab from 2 seconds to 5 seconds" keeps the words before the last times. */
  function captionOrder(full) {
    const head = full.match(/^(?:add|put) a caption saying (.+)$/);
    if (!head) return null;
    const rest = head[1];
    const toAt = rest.lastIndexOf(" to ");
    if (toAt < 0) return { op: "error", error: "Say the caption like this: add a caption saying hello from 2 seconds to 5 seconds." };
    const to = parseTimeExact(rest.slice(toAt + 4));
    if (to == null) return { op: "error", error: "Say when the caption ends, such as 5 seconds." };
    const left = rest.slice(0, toAt);
    const fromAt = left.lastIndexOf(" from ");
    if (fromAt < 0) return { op: "error", error: "Say when the caption starts, such as from 2 seconds." };
    const from = parseTimeExact(left.slice(fromAt + 6));
    if (from == null) return { op: "error", error: "Say when the caption starts, such as from 2 seconds." };
    const text = left.slice(0, fromAt).trim();
    if (!text) return { op: "error", error: "Say the words for the caption." };
    return { op: "caption", text, from, to };
  }

  return { parseMovieOrder, MOVIE_ORDERS };
});
