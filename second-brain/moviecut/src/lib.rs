//! Movie timeline for Hey my brain.
//!
//! OpenCut (https://github.com/opencut-app/opencut, MIT) is rewriting its editor
//! in Rust. That public rewrite cannot edit a movie yet: the desktop app is only
//! a window, and the shared crates are turned off. This library is the editor
//! this app calls. It stores clips on a timeline and ffmpeg writes the mp4.

mod export;
mod look;

use export::render;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
const FPS: u32 = 30;
/// How long a photo stays on screen when it is added.
const PHOTO_SECONDS: f64 = 4.0;

fn one() -> f64 { 1.0 }
fn width() -> u32 { WIDTH }
fn height() -> u32 { HEIGHT }
fn fps() -> u32 { FPS }
fn black() -> String { "black".into() }
fn white_color() -> String { "white".into() }
fn caption_size() -> u32 { 52 }

/// How fast one clip plays, once the movie speed and the clip's own speed are combined.
fn pace(project_speed: f64, rate: f64) -> f64 {
    let rate = if rate <= 0.0 { 1.0 } else { rate };
    project_speed * rate
}

#[derive(Clone, Serialize, Deserialize)]
struct Project {
    name: String,
    slug: String,
    #[serde(default = "width")]
    width: u32,
    #[serde(default = "height")]
    height: u32,
    #[serde(default = "fps")]
    fps: u32,
    #[serde(default = "one")]
    speed: f64,
    #[serde(default = "one")]
    volume: f64,
    #[serde(default)]
    muted: bool,
    #[serde(default)]
    fade_in: f64,
    #[serde(default)]
    fade_out: f64,
    #[serde(default)]
    clips: Vec<Clip>,
    #[serde(default)]
    captions: Vec<Caption>,
    #[serde(default)]
    export_path: String,
    /// "", or a transition name from TRANSITIONS. Used at every cut.
    #[serde(default)]
    transition: String,
    #[serde(default = "one")]
    transition_seconds: f64,
    /// Photos zoom in slowly while they are on screen.
    #[serde(default)]
    photo_zoom: bool,
    #[serde(default)]
    music: Option<Music>,
    /// Colour behind clips that do not fill the frame.
    #[serde(default = "black")]
    background: String,
    /// Fill the empty bars with a blurred copy of the clip.
    #[serde(default)]
    blur_background: bool,
    /// Black bars at the top and bottom, like a film frame.
    #[serde(default)]
    bars: bool,
    #[serde(default = "caption_size")]
    caption_size: u32,
    #[serde(default = "white_color")]
    caption_color: String,
    /// "", "grid", or "phone". Drawn on the preview only.
    #[serde(default)]
    guide: String,
    #[serde(default)]
    bookmarks: Vec<f64>,
    #[serde(default)]
    past: Vec<Snapshot>,
    /// The steps undo put aside, so redo can put them back.
    #[serde(default)]
    future: Vec<Snapshot>,
}

/// One song under the whole movie. It loops if the movie is longer.
#[derive(Clone, Serialize, Deserialize)]
struct Music {
    path: String,
    name: String,
    duration: f64,
    #[serde(default = "music_level")]
    volume: f64,
}

fn music_level() -> f64 { 0.35 }

/// Spoken name, then the ffmpeg xfade name.
const TRANSITIONS: &[(&str, &str)] = &[
    ("crossfade", "fade"),
    ("black", "fadeblack"),
    ("white", "fadewhite"),
    ("slide", "slideleft"),
    ("wipe", "wipeleft"),
    ("circle", "circleopen"),
    ("zoom", "zoomin"),
    // A different one at every cut. See transition_at.
    ("random", "fade"),
];

/// The ffmpeg name for the transition at cut `cut` (1 for the first cut).
/// "random" walks the list in a scrambled order, so the preview can do the same.
pub(crate) fn transition_at(project: &Project, cut: usize) -> &'static str {
    let name = if project.transition == "random" {
        TRANSITIONS[((cut.max(1) - 1) * 5 + 2) % 7].0
    } else {
        project.transition.as_str()
    };
    TRANSITIONS.iter().find(|(spoken, _)| *spoken == name).map(|(_, ffmpeg)| *ffmpeg).unwrap_or("fade")
}

#[derive(Clone, Serialize, Deserialize)]
struct Clip {
    id: String,
    path: String,
    name: String,
    duration: f64,
    start: f64,
    end: f64,
    #[serde(default)]
    has_audio: bool,
    /// A photo. Its path is the JPEG copy made when it was added.
    #[serde(default)]
    still: bool,
    /// Turned clockwise by 0, 90, 180, or 270 degrees.
    #[serde(default)]
    rotate: u32,
    /// 1 fills the frame. Smaller leaves a border. Up to 2.
    #[serde(default = "one")]
    scale: f64,
    /// 1 keeps the shape. Above 1 stretches wide. Below 1 stretches tall.
    #[serde(default = "one")]
    stretch: f64,
    /// Slide left or right, as a fraction of the frame. 0 is the centre.
    #[serde(default)]
    shift_x: f64,
    /// Slide up or down. Negative is up.
    #[serde(default)]
    shift_y: f64,
    /// 1 is solid. 0 is invisible.
    #[serde(default = "one")]
    opacity: f64,
    /// Loudness of this clip only, on top of the movie volume.
    #[serde(default = "one")]
    clip_volume: f64,
    #[serde(default)]
    clip_muted: bool,
    /// This clip's own speed. 1 is the same as the rest of the movie.
    #[serde(default = "one")]
    rate: f64,
    /// The clip stays on the timeline, but the picture and its sound are off.
    #[serde(default)]
    hidden: bool,
    /// Blur strength. 0 is sharp.
    #[serde(default)]
    blur: f64,
    /// "" or "circle".
    #[serde(default)]
    mask: String,
    /// "" or multiply, screen, overlay. Blends the clip with the background.
    #[serde(default)]
    blend: String,
    /// Slow push-in while this clip is on screen.
    #[serde(default)]
    zoom: bool,
    /// The user said to stop zooming this clip, even when photos zoom.
    #[serde(default)]
    zoom_off: bool,
}

/// A clip with the plain look: full frame, no blur, no mask.
fn plain_clip(id: String, path: String, name: String, duration: f64, has_audio: bool, still: bool) -> Clip {
    Clip {
        id,
        path,
        name,
        duration,
        start: 0.0,
        end: duration,
        has_audio,
        still,
        rotate: 0,
        scale: 1.0,
        stretch: 1.0,
        shift_x: 0.0,
        shift_y: 0.0,
        opacity: 1.0,
        clip_volume: 1.0,
        clip_muted: false,
        rate: 1.0,
        hidden: false,
        blur: 0.0,
        mask: String::new(),
        blend: String::new(),
        zoom: false,
        zoom_off: false,
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Caption {
    text: String,
    start: f64,
    end: f64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Snapshot {
    clips: Vec<Clip>,
    captions: Vec<Caption>,
    speed: f64,
    volume: f64,
    muted: bool,
    fade_in: f64,
    fade_out: f64,
    #[serde(default)]
    transition: String,
    #[serde(default = "one")]
    transition_seconds: f64,
    #[serde(default)]
    photo_zoom: bool,
    #[serde(default)]
    music: Option<Music>,
    #[serde(default = "width")]
    width: u32,
    #[serde(default = "height")]
    height: u32,
    #[serde(default = "black")]
    background: String,
    #[serde(default)]
    blur_background: bool,
    #[serde(default)]
    bars: bool,
    #[serde(default = "caption_size")]
    caption_size: u32,
    #[serde(default = "white_color")]
    caption_color: String,
    #[serde(default)]
    guide: String,
    #[serde(default)]
    bookmarks: Vec<f64>,
}

#[derive(Deserialize)]
struct CaptionIn {
    text: String,
    from: f64,
    to: f64,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Order {
    New { name: String },
    Add {
        file: String,
        /// Put it before the other clips, as for a title card.
        #[serde(default)]
        first: bool,
    },
    Rotate { clip: usize, degrees: i32 },
    Frame { kind: String },
    Background { color: String },
    BlurBackground { on: bool },
    Nudge { clip: usize, way: String },
    Scale { clip: usize, #[serde(default)] scale: Option<f64>, #[serde(default)] how: String },
    Stretch { clip: usize, how: String },
    Opacity { clip: usize, level: f64 },
    ClipMute { clip: usize, muted: bool },
    ClipVolume { clip: usize, level: f64 },
    ClipSpeed { clip: usize, rate: f64 },
    Hide { clip: usize, hidden: bool },
    Duplicate { clip: usize },
    BlurClip { clip: usize, amount: f64 },
    Mask { clip: usize, kind: String },
    Bars { on: bool },
    Blend { clip: usize, kind: String },
    ZoomClip { clip: usize, on: bool },
    CaptionStyle { #[serde(default)] color: String, #[serde(default)] size: String },
    MoveClip { clip: usize, place: String, #[serde(default)] target: usize },
    ResetLook { clip: usize },
    Bookmark { at: f64 },
    ClearBookmarks,
    Guide { kind: String },
    Redo,
    Transition { kind: String, #[serde(default)] seconds: Option<f64> },
    PhotoZoom { on: bool },
    Music { file: String },
    MusicVolume { level: f64 },
    NoMusic,
    Captions { items: Vec<CaptionIn> },
    CutStart { seconds: f64 },
    CutEnd { seconds: f64 },
    Keep { from: f64, to: f64 },
    Remove { from: f64, to: f64 },
    Split { at: f64 },
    Drop { clip: usize },
    Speed { rate: f64 },
    Mute,
    Unmute,
    Volume { level: f64 },
    FadeIn { seconds: f64 },
    FadeOut { seconds: f64 },
    Caption { text: String, from: f64, to: f64 },
    ClearCaptions,
    Undo,
    Status,
    Export,
    Clear,
}

/// Runs one order. `root` is the movies folder, usually ~/.brain/movies.
/// Returns one JSON object as text: ok, a sentence to say, and the project summary.
pub fn apply(root: &Path, raw: &str) -> Result<String, String> {
    let order: Order = serde_json::from_str(raw.trim())
        .map_err(|_| "That movie order could not be read.".to_string())?;
    let reply = apply_order(root, order)?;
    serde_json::to_string(&reply).map_err(|_| "The movie reply could not be written.".to_string())
}

fn apply_order(root: &Path, order: Order) -> Result<Value, String> {
    fs::create_dir_all(root).map_err(|_| "Could not create the movies folder.".to_string())?;
    match order {
        Order::New { name } => new_movie(root, &name),
        Order::Status => {
            let project = load_current(root)?;
            Ok(ok(&project, &status_line(&project)))
        }
        other => {
            let mut project = load_current(root)?;
            let said = match other {
                Order::Add { file, first } => project.add_file(root, &file, first)?,
                Order::Rotate { clip, degrees } => project.rotate(clip, degrees)?,
                Order::Frame { kind } => project.set_frame(&kind)?,
                Order::Background { color } => project.set_background(&color)?,
                Order::BlurBackground { on } => project.set_blur_background(on),
                Order::Nudge { clip, way } => project.nudge(clip, &way)?,
                Order::Scale { clip, scale, how } => project.set_scale(clip, scale, &how)?,
                Order::Stretch { clip, how } => project.set_stretch(clip, &how)?,
                Order::Opacity { clip, level } => project.set_opacity(clip, level)?,
                Order::ClipMute { clip, muted } => project.set_clip_muted(clip, muted)?,
                Order::ClipVolume { clip, level } => project.set_clip_volume(clip, level)?,
                Order::ClipSpeed { clip, rate } => project.set_clip_speed(clip, rate)?,
                Order::Hide { clip, hidden } => project.set_hidden(clip, hidden)?,
                Order::Duplicate { clip } => project.duplicate(clip)?,
                Order::BlurClip { clip, amount } => project.set_blur(clip, amount)?,
                Order::Mask { clip, kind } => project.set_mask(clip, &kind)?,
                Order::Bars { on } => project.set_bars(on),
                Order::Blend { clip, kind } => project.set_blend(clip, &kind)?,
                Order::ZoomClip { clip, on } => project.set_clip_zoom(clip, on)?,
                Order::CaptionStyle { color, size } => project.set_caption_style(&color, &size)?,
                Order::MoveClip { clip, place, target } => project.move_clip(clip, &place, target)?,
                Order::ResetLook { clip } => project.reset_look(clip)?,
                Order::Bookmark { at } => project.add_bookmark(at)?,
                Order::ClearBookmarks => project.clear_bookmarks(),
                Order::Guide { kind } => project.set_guide(&kind)?,
                Order::Redo => project.redo()?,
                Order::Transition { kind, seconds } => project.set_transition(&kind, seconds)?,
                Order::PhotoZoom { on } => project.set_photo_zoom(on),
                Order::Music { file } => project.set_music(&file)?,
                Order::MusicVolume { level } => project.set_music_volume(level)?,
                Order::NoMusic => project.remove_music()?,
                Order::Captions { items } => project.set_captions(items)?,
                Order::CutStart { seconds } => project.cut_edge(seconds, true)?,
                Order::CutEnd { seconds } => project.cut_edge(seconds, false)?,
                Order::Keep { from, to } => project.keep(from, to)?,
                Order::Remove { from, to } => project.remove_span(from, to, true)?,
                Order::Split { at } => project.split_at(at)?,
                Order::Drop { clip } => project.drop_clip(clip)?,
                Order::Speed { rate } => project.set_speed(rate)?,
                Order::Mute => project.set_muted(true),
                Order::Unmute => project.set_muted(false),
                Order::Volume { level } => project.set_volume(level)?,
                Order::FadeIn { seconds } => project.set_fade(true, seconds)?,
                Order::FadeOut { seconds } => project.set_fade(false, seconds)?,
                Order::Caption { text, from, to } => project.add_caption(text, from, to)?,
                Order::ClearCaptions => project.clear_captions(),
                Order::Undo => project.undo()?,
                Order::Export => project.export()?,
                Order::Clear => project.clear_movie(),
                Order::New { .. } | Order::Status => unreachable!("handled above"),
            };
            project.save(root)?;
            Ok(ok(&project, &said))
        }
    }
}

fn ok(project: &Project, said: &str) -> Value {
    json!({ "ok": true, "said": said, "project": project.summary() })
}

fn new_movie(root: &Path, name: &str) -> Result<Value, String> {
    let (display, slug) = clean_name(name)?;
    let path = project_path(root, &slug);
    if path.is_file() {
        let project = read_project(&path)?;
        write_current(root, &slug)?;
        let said = format!(
            "Opened the movie {}. {}",
            project.name,
            if project.clips.is_empty() { "It has no clips yet.".into() } else { status_line(&project) }
        );
        return Ok(ok(&project, &said));
    }
    let project = Project {
        name: display,
        slug: slug.clone(),
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        speed: 1.0,
        volume: 1.0,
        muted: false,
        fade_in: 0.0,
        fade_out: 0.0,
        clips: Vec::new(),
        captions: Vec::new(),
        export_path: String::new(),
        transition: String::new(),
        transition_seconds: 1.0,
        photo_zoom: true,
        music: None,
        background: "black".into(),
        blur_background: false,
        bars: false,
        caption_size: 52,
        caption_color: "white".into(),
        guide: String::new(),
        bookmarks: Vec::new(),
        past: Vec::new(),
        future: Vec::new(),
    };
    project.save(root)?;
    write_current(root, &slug)?;
    Ok(ok(&project, &format!("Started a movie called {}. Say add the video, then the file name.", project.name)))
}

impl Project {
    fn length(&self) -> f64 {
        self.clips.iter().map(|clip| ((clip.end - clip.start) / pace(self.speed, clip.rate)).max(0.0)).sum()
    }

    fn save(&self, root: &Path) -> Result<(), String> {
        let path = project_path(root, &self.slug);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|_| "Could not save the movie.".to_string())?;
        }
        let text = serde_json::to_string_pretty(self).map_err(|_| "Could not save the movie.".to_string())?;
        fs::write(&path, text).map_err(|_| "Could not save the movie.".to_string())?;
        write_current(root, &self.slug)
    }

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            clips: self.clips.clone(),
            captions: self.captions.clone(),
            speed: self.speed,
            volume: self.volume,
            muted: self.muted,
            fade_in: self.fade_in,
            fade_out: self.fade_out,
            transition: self.transition.clone(),
            transition_seconds: self.transition_seconds,
            photo_zoom: self.photo_zoom,
            music: self.music.clone(),
            width: self.width,
            height: self.height,
            background: self.background.clone(),
            blur_background: self.blur_background,
            bars: self.bars,
            caption_size: self.caption_size,
            caption_color: self.caption_color.clone(),
            guide: self.guide.clone(),
            bookmarks: self.bookmarks.clone(),
        }
    }

    /// Puts a saved step back. Does not touch the undo or redo lists.
    fn restore(&mut self, snap: Snapshot) {
        self.clips = snap.clips;
        self.captions = snap.captions;
        self.speed = snap.speed;
        self.volume = snap.volume;
        self.muted = snap.muted;
        self.fade_in = snap.fade_in;
        self.fade_out = snap.fade_out;
        self.transition = snap.transition;
        self.transition_seconds = snap.transition_seconds;
        self.photo_zoom = snap.photo_zoom;
        self.music = snap.music;
        self.width = snap.width;
        self.height = snap.height;
        self.background = snap.background;
        self.blur_background = snap.blur_background;
        self.bars = snap.bars;
        self.caption_size = snap.caption_size;
        self.caption_color = snap.caption_color;
        self.guide = snap.guide;
        self.bookmarks = snap.bookmarks;
    }

    /// Runs a change. The previous movie is kept so undo can put it back.
    fn change<F>(&mut self, body: F) -> Result<String, String>
    where
        F: FnOnce(&mut Project) -> Result<String, String>,
    {
        let snap = self.snapshot();
        let said = body(self)?;
        self.past.push(snap);
        if self.past.len() > 20 {
            self.past.remove(0);
        }
        // A new change forgets the redo list. Redo only follows an undo.
        self.future.clear();
        Ok(said)
    }

    fn add_file(&mut self, root: &Path, file: &str, first: bool) -> Result<String, String> {
        let path = real_home_file(file)?;
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("video").to_string();
        if is_photo_name(&name) {
            return self.add_photo(root, &path, name);
        }
        if !is_video_name(&name) {
            return Err("That file is not a video or a photo. Use mp4, mov, m4v, webm, mkv, avi, jpg, png, or heic.".into());
        }
        let probed = probe(&path)?;
        let id = next_id(&self.clips);
        let duration = probed.duration;
        let said = format!("Added {}. It is {}.", name, spoken_len(duration));
        self.change(|project| {
            let clip = plain_clip(id, path.to_string_lossy().into_owned(), name, duration, probed.has_audio, false);
            if first {
                // Everything moves later, so the captions move with it.
                let shift = clip.end / project.speed;
                for caption in project.captions.iter_mut() {
                    caption.start += shift;
                    caption.end += shift;
                }
                project.clips.insert(0, clip);
            } else {
                project.clips.push(clip);
            }
            Ok(said)
        })
    }

    /// Photos are copied to a JPEG first. The browser cannot show HEIC, and
    /// one format keeps the preview and the exported movie the same.
    fn add_photo(&mut self, root: &Path, path: &Path, name: String) -> Result<String, String> {
        let id = next_id(&self.clips);
        let dir = root.join(&self.slug).join("photos");
        fs::create_dir_all(&dir).map_err(|_| "Could not make the photos folder.".to_string())?;
        let copy = dir.join(format!("{id}.jpg"));
        photo_copy(path, &copy)?;
        let said = format!("Added the photo {}. It shows for {}.", name, spoken_len(PHOTO_SECONDS));
        self.change(|project| {
            project.clips.push(plain_clip(id, copy.to_string_lossy().into_owned(), name, PHOTO_SECONDS, false, true));
            Ok(said)
        })
    }

    /// Clip numbers start at 1. 0 means the last clip.
    fn clip_index(&self, clip_number: usize) -> Result<usize, String> {
        if self.clips.is_empty() {
            return Err("Add a video first.".into());
        }
        if clip_number == 0 {
            return Ok(self.clips.len() - 1);
        }
        if clip_number > self.clips.len() {
            return Err(format!("There is no clip {clip_number}. The movie has {}.", clip_count(self.clips.len())));
        }
        Ok(clip_number - 1)
    }

    fn rotate(&mut self, clip_number: usize, degrees: i32) -> Result<String, String> {
        if degrees % 90 != 0 {
            return Err("Say rotate right, rotate left, or turn upside down.".into());
        }
        let index = self.clip_index(clip_number)?;
        self.change(|project| {
            let clip = &mut project.clips[index];
            clip.rotate = (clip.rotate as i32 + degrees).rem_euclid(360) as u32;
            Ok(match clip.rotate {
                0 => format!("Clip {} is the right way up again.", index + 1),
                180 => format!("Turned clip {} upside down.", index + 1),
                angle => format!("Turned clip {} {}.", index + 1, if angle == 90 { "to the right" } else { "to the left" }),
            })
        })
    }

    fn set_transition(&mut self, kind: &str, seconds: Option<f64>) -> Result<String, String> {
        let kind = kind.trim().to_lowercase();
        if kind == "none" || kind.is_empty() {
            if self.transition.is_empty() {
                return Ok("The movie has no transitions.".into());
            }
            return self.change(|project| {
                project.transition.clear();
                Ok("Removed the transitions. The clips cut straight to each other.".into())
            });
        }
        let kind = if kind == "same" { self.transition.clone() } else { kind };
        if !TRANSITIONS.iter().any(|(name, _)| *name == kind) {
            let names: Vec<&str> = TRANSITIONS.iter().map(|(name, _)| *name).collect();
            return Err(format!("Say one of these transitions: {}.", names.join(", ")));
        }
        let seconds = seconds.unwrap_or(self.transition_seconds);
        if !seconds.is_finite() || !(0.2..=3.0).contains(&seconds) {
            return Err("Say a transition from a fifth of a second to 3 seconds.".into());
        }
        self.change(|project| {
            project.transition = kind.clone();
            project.transition_seconds = seconds;
            Ok(if kind == "random" {
                format!("Each cut now gets a different transition, {} long.", spoken_len(seconds))
            } else {
                format!("Each cut now uses a {} transition of {}.", kind, spoken_len(seconds))
            })
        })
    }

    fn set_photo_zoom(&mut self, on: bool) -> String {
        if self.photo_zoom == on {
            return if on { "The photos already zoom.".into() } else { "The photos already stay still.".into() };
        }
        let _ = self.change(|project| {
            project.photo_zoom = on;
            Ok(String::new())
        });
        if on { "The photos now zoom in slowly.".into() } else { "The photos now stay still.".into() }
    }

    fn set_music(&mut self, file: &str) -> Result<String, String> {
        let path = real_home_file(file)?;
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("music").to_string();
        if !is_music_name(&name) {
            return Err("That file is not music. Use mp3, m4a, wav, aac, aiff, or flac.".into());
        }
        let duration = probe_audio(&path)?;
        let volume = self.music.as_ref().map(|music| music.volume).unwrap_or_else(music_level);
        self.change(|project| {
            project.music = Some(Music { path: path.to_string_lossy().into_owned(), name: name.clone(), duration, volume });
            Ok(format!("Added {name} as music. It gets quieter when someone talks."))
        })
    }

    fn set_music_volume(&mut self, level: f64) -> Result<String, String> {
        if self.music.is_none() {
            return Err("The movie has no music. Say add the music, then its name.".into());
        }
        if !level.is_finite() || !(0.0..=1.0).contains(&level) {
            return Err("Say a music volume from 0 to 100 percent.".into());
        }
        self.change(|project| {
            if let Some(music) = project.music.as_mut() {
                music.volume = level;
            }
            Ok(format!("Set the music to {} percent.", (level * 100.0).round() as i64))
        })
    }

    fn remove_music(&mut self) -> Result<String, String> {
        if self.music.is_none() {
            return Ok("The movie has no music.".into());
        }
        self.change(|project| {
            project.music = None;
            Ok("Removed the music.".into())
        })
    }

    /// Captions written from the speech. They replace the captions there were.
    fn set_captions(&mut self, items: Vec<CaptionIn>) -> Result<String, String> {
        if self.clips.is_empty() {
            return Err("Add a video first.".into());
        }
        let total = self.length();
        let mut captions = Vec::new();
        for item in items {
            let Ok(text) = clean_caption(&item.text) else { continue };
            if !item.from.is_finite() || !item.to.is_finite() || item.from < 0.0 || item.from >= total {
                continue;
            }
            let end = item.to.min(total);
            if end - item.from < 0.1 {
                continue;
            }
            captions.push(Caption { text, start: item.from, end });
        }
        if captions.is_empty() {
            return Err("No speech was heard in the movie, so there are no captions.".into());
        }
        let count = captions.len();
        self.change(|project| {
            project.captions = captions;
            Ok(format!("Wrote {count} captions from the speech."))
        })
    }

    fn cut_edge(&mut self, seconds: f64, from_start: bool) -> Result<String, String> {
        let seconds = check_seconds(seconds, "Say how many seconds to cut.")?;
        let total = self.length();
        if seconds <= 0.0 {
            return Err("Say how many seconds to cut.".into());
        }
        if seconds >= total - 0.05 {
            return Err("That would leave nothing in the movie.".into());
        }
        let (from, to) = if from_start { (0.0, seconds) } else { ((total - seconds).max(0.0), total) };
        self.remove_between(from, to)?;
        Ok(format!("Cut {}. The movie is now {}.", spoken_len(seconds), spoken_len(self.length())))
    }

    fn keep(&mut self, from: f64, to: f64) -> Result<String, String> {
        let from = check_seconds(from, "Say when the part you want starts.")?;
        let to = check_seconds(to, "Say when the part you want ends.")?;
        if to <= from {
            return Err("The end time has to be after the start time.".into());
        }
        let total = self.length();
        if from >= total {
            return Err("That is past the end of the movie.".into());
        }
        let to = to.min(total);
        if to - from < 0.1 {
            return Err("That would leave nothing in the movie.".into());
        }
        // One undo step for both cuts. The ending goes first so the start time stays put.
        self.change(|project| {
            if to < total - 0.02 {
                project.excise(to, total)?;
            }
            if from > 0.02 {
                project.excise(0.0, from)?;
            }
            Ok(format!("Kept {}. The movie is now {}.", spoken_len(to - from), spoken_len(project.length())))
        })
    }

    fn remove_span(&mut self, from: f64, to: f64, speak: bool) -> Result<String, String> {
        let from = check_seconds(from, "Say when the cut starts.")?;
        let to = check_seconds(to, "Say when the cut ends.")?;
        if to <= from {
            return Err("The end time has to be after the start time.".into());
        }
        self.remove_between(from, to)?;
        if speak {
            Ok(format!("Removed that part. The movie is now {}.", spoken_len(self.length())))
        } else {
            Ok(String::new())
        }
    }

    /// Drops the output-time span and shifts later captions. Records one undo.
    fn remove_between(&mut self, from: f64, to: f64) -> Result<String, String> {
        let total = self.length();
        if self.clips.is_empty() {
            return Err("Add a video first.".into());
        }
        if from >= total {
            return Err("That is past the end of the movie.".into());
        }
        let to = to.min(total);
        if to - from < 0.05 {
            return Err("That cut is too short.".into());
        }
        self.change(|project| {
            let dropped = project.excise(from, to)?;
            let mut said = format!("Removed that part. The movie is now {}.", spoken_len(project.length()));
            if dropped > 0 {
                said.push_str(" Captions in that part were removed.");
            }
            Ok(said)
        })
    }

    /// Cuts a span out of the timeline. Does not record undo. Returns how many captions were dropped.
    fn excise(&mut self, from: f64, to: f64) -> Result<usize, String> {
        let mut cursor = 0.0;
        let mut next = Vec::new();
        let mut counter = next_number(&self.clips);
        for clip in self.clips.iter() {
            let speed = pace(self.speed, clip.rate);
            let len = ((clip.end - clip.start) / speed).max(0.0);
            let t0 = cursor;
            let t1 = cursor + len;
            cursor = t1;
            let overlap_start = from.max(t0);
            let overlap_end = to.min(t1);
            if overlap_end <= overlap_start + 0.001 {
                next.push(clip.clone());
                continue;
            }
            if overlap_start > t0 + 0.05 {
                let mut left = clip.clone();
                left.end = clip.start + (overlap_start - t0) * speed;
                if left.end - left.start >= 0.05 {
                    next.push(left);
                }
            }
            if overlap_end < t1 - 0.05 {
                let mut right = clip.clone();
                right.start = clip.start + (overlap_end - t0) * speed;
                counter += 1;
                right.id = format!("c{counter}");
                if right.end - right.start >= 0.05 {
                    next.push(right);
                }
            }
        }
        if next.is_empty() {
            return Err("That would leave nothing in the movie.".into());
        }
        self.clips = next;
        let removed = to - from;
        let mut captions = Vec::new();
        let mut dropped = 0;
        for caption in self.captions.iter() {
            if caption.end <= from + 0.001 {
                captions.push(caption.clone());
            } else if caption.start >= to - 0.001 {
                let mut moved = caption.clone();
                moved.start = (caption.start - removed).max(0.0);
                moved.end = (caption.end - removed).max(0.0);
                if moved.end - moved.start >= 0.1 {
                    captions.push(moved);
                }
            } else {
                dropped += 1;
            }
        }
        self.captions = captions;
        Ok(dropped)
    }

    fn split_at(&mut self, at: f64) -> Result<String, String> {
        let at = check_seconds(at, "Say where to split, such as 15 seconds.")?;
        if self.clips.is_empty() {
            return Err("Add a video first.".into());
        }
        let total = self.length();
        if at <= 0.05 || at >= total - 0.05 {
            return Err("That is already an edge of the movie.".into());
        }
        self.change(|project| {
            let speed = project.speed;
            let mut cursor = 0.0;
            let mut next = Vec::new();
            let mut counter = next_number(&project.clips);
            let mut did = false;
            for clip in project.clips.iter() {
                let speed = pace(speed, clip.rate);
                let len = ((clip.end - clip.start) / speed).max(0.0);
                let t0 = cursor;
                let t1 = cursor + len;
                cursor = t1;
                if did || at <= t0 + 0.05 || at >= t1 - 0.05 {
                    next.push(clip.clone());
                    continue;
                }
                let mut left = clip.clone();
                left.end = clip.start + (at - t0) * speed;
                let mut right = clip.clone();
                right.start = left.end;
                counter += 1;
                right.id = format!("c{counter}");
                if left.end - left.start < 0.05 || right.end - right.start < 0.05 {
                    return Err("That split is too close to the edge of a clip.".into());
                }
                next.push(left);
                next.push(right);
                did = true;
            }
            if !did {
                return Err("That is already a cut between clips.".into());
            }
            project.clips = next;
            Ok(format!("Split the movie at {}.", spoken_len(at)))
        })
    }

    fn drop_clip(&mut self, clip_number: usize) -> Result<String, String> {
        if self.clips.is_empty() {
            return Err("There is no clip to drop.".into());
        }
        let index = if clip_number == 0 {
            self.clips.len() - 1
        } else if clip_number > self.clips.len() {
            return Err(format!("There is no clip {clip_number}. The movie has {}.", clip_count(self.clips.len())));
        } else {
            clip_number - 1
        };
        let (t0, t1) = self.clip_span(index);
        let name = self.clips[index].name.clone();
        // Dropping the only clip is allowed: the movie becomes empty.
        if self.clips.len() == 1 {
            return self.change(|project| {
                project.clips.clear();
                project.captions.clear();
                Ok(format!("Dropped {name}. The movie is empty."))
            });
        }
        self.remove_between(t0, t1)?;
        Ok(format!("Dropped {name}. The movie is now {}.", spoken_len(self.length())))
    }

    fn clip_span(&self, index: usize) -> (f64, f64) {
        let mut cursor = 0.0;
        for (i, clip) in self.clips.iter().enumerate() {
            let len = ((clip.end - clip.start) / pace(self.speed, clip.rate)).max(0.0);
            if i == index {
                return (cursor, cursor + len);
            }
            cursor += len;
        }
        (0.0, 0.0)
    }

    fn set_speed(&mut self, rate: f64) -> Result<String, String> {
        if !rate.is_finite() {
            return Err("Say a speed such as twice, half, or 1.5.".into());
        }
        if !(0.25..=4.0).contains(&rate) {
            return Err("The speed has to be between a quarter and 4.".into());
        }
        let old = self.speed;
        if (old - rate).abs() < 0.001 {
            return Ok(format!("The movie is already at {} speed.", speed_words(rate)));
        }
        self.change(|project| {
            let scale = old / rate;
            for caption in project.captions.iter_mut() {
                caption.start *= scale;
                caption.end *= scale;
            }
            project.captions.retain(|caption| caption.end - caption.start >= 0.1);
            project.speed = rate;
            Ok(format!(
                "The movie now plays at {} speed. It is {}.",
                speed_words(rate),
                spoken_len(project.length())
            ))
        })
    }

    fn set_muted(&mut self, muted: bool) -> String {
        if self.muted == muted {
            return if muted { "The movie is already muted.".into() } else { "The movie already has sound.".into() };
        }
        let _ = self.change(|project| {
            project.muted = muted;
            Ok(String::new())
        });
        if muted { "Muted the movie.".into() } else { "Turned the sound back on.".into() }
    }

    fn set_volume(&mut self, level: f64) -> Result<String, String> {
        if !level.is_finite() || !(0.0..=2.0).contains(&level) {
            return Err("Say a volume from 0 to 200 percent.".into());
        }
        self.change(|project| {
            project.volume = level;
            project.muted = false;
            Ok(format!("Set the volume to {} percent.", (level * 100.0).round() as i64))
        })
    }

    fn set_fade(&mut self, fade_in: bool, seconds: f64) -> Result<String, String> {
        let seconds = check_seconds(seconds, "Say how long the fade is.")?;
        if seconds <= 0.0 || seconds > 10.0 {
            return Err("Say a fade from a tenth of a second up to 10 seconds.".into());
        }
        self.change(|project| {
            if fade_in { project.fade_in = seconds; } else { project.fade_out = seconds; }
            let which = if fade_in { "in" } else { "out" };
            Ok(format!("The movie fades {which} over {}.", spoken_len(seconds)))
        })
    }

    fn add_caption(&mut self, text: String, from: f64, to: f64) -> Result<String, String> {
        let from = check_seconds(from, "Say when the caption starts.")?;
        let to = check_seconds(to, "Say when the caption ends.")?;
        if to <= from {
            return Err("The caption has to end after it starts.".into());
        }
        if self.clips.is_empty() {
            return Err("Add a video first.".into());
        }
        let total = self.length();
        if from >= total {
            return Err("That caption starts after the movie ends.".into());
        }
        let text = clean_caption(&text)?;
        let end = to.min(total);
        self.change(|project| {
            project.captions.push(Caption { text: text.clone(), start: from, end });
            Ok(format!("Added a caption from {} to {}.", spoken_len(from), spoken_len(end)))
        })
    }

    fn clear_captions(&mut self) -> String {
        if self.captions.is_empty() {
            return "There are no captions.".into();
        }
        let _ = self.change(|project| {
            project.captions.clear();
            Ok(String::new())
        });
        "Removed the captions.".into()
    }

    fn clear_movie(&mut self) -> String {
        let _ = self.change(|project| {
            project.clips.clear();
            project.captions.clear();
            project.speed = 1.0;
            project.volume = 1.0;
            project.muted = false;
            project.fade_in = 0.0;
            project.fade_out = 0.0;
            project.transition.clear();
            project.music = None;
            project.background = "black".into();
            project.blur_background = false;
            project.bars = false;
            project.caption_size = 52;
            project.caption_color = "white".into();
            project.guide.clear();
            project.bookmarks.clear();
            project.width = WIDTH;
            project.height = HEIGHT;
            Ok(String::new())
        });
        format!("Cleared {}. Say add the video to start again.", self.name)
    }

    fn undo(&mut self) -> Result<String, String> {
        let Some(snap) = self.past.pop() else {
            return Err("There is nothing to undo.".into());
        };
        self.future.push(self.snapshot());
        if self.future.len() > 20 {
            self.future.remove(0);
        }
        self.restore(snap);
        Ok(format!("Undid that. {}", status_line(self)))
    }

    fn redo(&mut self) -> Result<String, String> {
        let Some(snap) = self.future.pop() else {
            return Err("There is nothing to redo.".into());
        };
        self.past.push(self.snapshot());
        if self.past.len() > 20 {
            self.past.remove(0);
        }
        self.restore(snap);
        Ok(format!("Redid that. {}", status_line(self)))
    }

    fn export(&mut self) -> Result<String, String> {
        let dest = export_destination(&self.name)?;
        render(self, &dest)?;
        self.export_path = dest.to_string_lossy().into_owned();
        Ok(format!("Made the movie. It is in Movies as {}.", dest.file_name().and_then(|n| n.to_str()).unwrap_or("the file")))
    }

    fn summary(&self) -> Value {
        json!({
            "name": self.name,
            "slug": self.slug,
            "seconds": (self.length() * 10.0).round() / 10.0,
            "speed": self.speed,
            "volume": self.volume,
            "muted": self.muted,
            "fadeIn": self.fade_in,
            "fadeOut": self.fade_out,
            "exportPath": self.export_path,
            "clips": self.clips.iter().map(|clip| json!({
                "id": clip.id,
                "name": clip.name,
                "path": clip.path,
                "start": clip.start,
                "end": clip.end,
                "duration": clip.duration,
                "still": clip.still,
                "rotate": clip.rotate,
                "hasAudio": clip.has_audio,
                "scale": clip.scale,
                "stretch": clip.stretch,
                "shiftX": clip.shift_x,
                "shiftY": clip.shift_y,
                "opacity": clip.opacity,
                "clipVolume": clip.clip_volume,
                "clipMuted": clip.clip_muted,
                "rate": clip.rate,
                "hidden": clip.hidden,
                "blur": clip.blur,
                "mask": clip.mask,
                "blend": clip.blend,
                "zoom": clip.zoom,
                "zoomOff": clip.zoom_off,
            })).collect::<Vec<_>>(),
            "width": self.width,
            "height": self.height,
            "fps": self.fps,
            "background": self.background,
            "blurBackground": self.blur_background,
            "bars": self.bars,
            "captionSize": self.caption_size,
            "captionColor": self.caption_color,
            "guide": self.guide,
            "bookmarks": self.bookmarks,
            "transition": self.transition,
            "transitionSeconds": self.transition_seconds,
            "photoZoom": self.photo_zoom,
            "musicPath": self.music.as_ref().map(|music| music.path.clone()).unwrap_or_default(),
            "music": self.music.as_ref().map(|music| json!({
                "name": music.name,
                "volume": music.volume,
                "duration": music.duration,
            })),
            "captions": self.captions.iter().map(|caption| json!({
                "text": caption.text,
                "start": caption.start,
                "end": caption.end,
            })).collect::<Vec<_>>(),
        })
    }
}

fn status_line(project: &Project) -> String {
    if project.clips.is_empty() {
        return format!("The movie {} has no clips yet.", project.name);
    }
    format!(
        "The movie {} has {} and is {}.",
        project.name,
        clip_count(project.clips.len()),
        spoken_len(project.length())
    )
}

fn clip_count(count: usize) -> String {
    if count == 1 { "1 clip".into() } else { format!("{count} clips") }
}

fn speed_words(rate: f64) -> String {
    if (rate - 1.0).abs() < 0.01 { "normal".into() }
    else if (rate - 2.0).abs() < 0.01 { "double".into() }
    else if (rate - 0.5).abs() < 0.01 { "half".into() }
    else { format!("{rate:.2}") }
}

fn spoken_len(seconds: f64) -> String {
    let whole = seconds.round().max(0.0) as i64;
    if whole < 60 {
        return format!("{whole} second{}", if whole == 1 { "" } else { "s" });
    }
    let minutes = whole / 60;
    let rest = whole % 60;
    if rest == 0 {
        format!("{minutes} minute{}", if minutes == 1 { "" } else { "s" })
    } else {
        format!(
            "{minutes} minute{} {rest} second{}",
            if minutes == 1 { "" } else { "s" },
            if rest == 1 { "" } else { "s" }
        )
    }
}

fn check_seconds(value: f64, complaint: &str) -> Result<f64, String> {
    if !value.is_finite() || value < 0.0 {
        return Err(complaint.into());
    }
    Ok(value)
}

fn clean_caption(text: &str) -> Result<String, String> {
    let cleaned: String = text
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned: String = cleaned.chars().filter(|ch| !matches!(ch, '\\' | ':' | '\'' | '%')).collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() {
        return Err("Say the words for the caption.".into());
    }
    if cleaned.chars().count() > 120 {
        return Err("That caption is too long. Keep it under 120 letters.".into());
    }
    Ok(cleaned)
}

fn clean_name(name: &str) -> Result<(String, String), String> {
    let display = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let display: String = display.chars().filter(|ch| ch.is_ascii() && (ch.is_alphanumeric() || *ch == ' ' || *ch == '-')).collect();
    let display = display.trim().to_string();
    if display.is_empty() || display.chars().count() > 40 {
        return Err("Give the movie a short name, using letters and numbers.".into());
    }
    let slug: String = display
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    let slug = slug.split('-').filter(|part| !part.is_empty()).collect::<Vec<_>>().join("-");
    if slug.is_empty() {
        return Err("Give the movie a short name, using letters and numbers.".into());
    }
    let slug = slug.chars().take(40).collect::<String>().trim_matches('-').to_string();
    Ok((display, slug))
}

fn is_video_name(name: &str) -> bool {
    matches!(
        Path::new(name).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_lowercase().as_str(),
        "mp4" | "mov" | "m4v" | "webm" | "mkv" | "avi"
    )
}

fn is_music_name(name: &str) -> bool {
    matches!(
        Path::new(name).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_lowercase().as_str(),
        "mp3" | "m4a" | "wav" | "aac" | "aif" | "aiff" | "flac"
    )
}

/// How long a song is. Fails when the file has no sound.
fn probe_audio(path: &Path) -> Result<f64, String> {
    let output = Command::new(export::ffprobe_bin())
        .args(["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json"])
        .arg(path)
        .output()
        .map_err(|_| "ffprobe is not installed. Install ffmpeg with Homebrew, then try again.".to_string())?;
    let parsed: Value = serde_json::from_slice(&output.stdout).map_err(|_| "Could not read that music.".to_string())?;
    let has_audio = parsed["streams"].as_array().map(|streams| {
        streams.iter().any(|stream| stream["codec_type"] == "audio")
    }).unwrap_or(false);
    if !output.status.success() || !has_audio {
        return Err("That file has no sound.".into());
    }
    parsed["format"]["duration"].as_str().and_then(|text| text.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.5)
        .ok_or_else(|| "Could not tell how long that music is.".to_string())
}

fn is_photo_name(name: &str) -> bool {
    matches!(
        Path::new(name).extension().and_then(|ext| ext.to_str()).unwrap_or("").to_lowercase().as_str(),
        "jpg" | "jpeg" | "png" | "heic" | "heif" | "tif" | "tiff" | "webp"
    )
}

/// Writes a JPEG of the photo, at most 2400 pixels wide, turned the right way up.
/// sips comes with macOS and reads HEIC.
fn photo_copy(from: &Path, to: &Path) -> Result<(), String> {
    let failed = || "Could not read that photo.".to_string();
    let output = Command::new("/usr/bin/sips")
        .args(["-s", "format", "jpeg", "-s", "formatOptions", "88", "-Z", "2400"])
        .arg(from)
        .arg("--out")
        .arg(to)
        .output()
        .map_err(|_| failed())?;
    if !output.status.success() || !to.is_file() {
        return Err(failed());
    }
    // Phones often save a sideways picture plus a note to turn it. ffmpeg ignores
    // the note, so the picture itself is turned and the preview ignores the note too.
    let info = Command::new("/usr/bin/sips").args(["-g", "orientation"]).arg(to).output().map_err(|_| failed())?;
    let text = String::from_utf8_lossy(&info.stdout);
    let turn = match text.lines().last().unwrap_or("").split(':').nth(1).map(str::trim) {
        Some("3") => "180",
        Some("6") => "90",
        Some("8") => "270",
        _ => return Ok(()),
    };
    let status = Command::new("/usr/bin/sips").args(["-r", turn]).arg(to).output().map_err(|_| failed())?;
    if !status.status.success() {
        return Err(failed());
    }
    Ok(())
}

struct Probe {
    duration: f64,
    has_audio: bool,
}

fn probe(path: &Path) -> Result<Probe, String> {
    let output = Command::new(export::ffprobe_bin())
        .args(["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json"])
        .arg(path)
        .output()
        .map_err(|_| "ffprobe is not installed. Install ffmpeg with Homebrew, then try again.".to_string())?;
    if !output.status.success() {
        return Err(format!("Could not read the video {}.", path.file_name().and_then(|n| n.to_str()).unwrap_or("file")));
    }
    let parsed: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Could not read that video.".to_string())?;
    let has_video = parsed["streams"].as_array().map(|streams| {
        streams.iter().any(|stream| stream["codec_type"] == "video")
    }).unwrap_or(false);
    if !has_video {
        return Err("That file has no picture.".into());
    }
    let has_audio = parsed["streams"].as_array().map(|streams| {
        streams.iter().any(|stream| stream["codec_type"] == "audio")
    }).unwrap_or(false);
    let duration = parsed["format"]["duration"].as_str().and_then(|text| text.parse::<f64>().ok())
        .or_else(|| parsed["format"]["duration"].as_f64())
        .filter(|value| value.is_finite() && *value > 0.05)
        .ok_or_else(|| "Could not tell how long that video is.".to_string())?;
    Ok(Probe { duration, has_audio })
}

fn real_home_file(file: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(file);
    if !path.is_file() {
        return Err("That video could not be found.".into());
    }
    let real = path.canonicalize().map_err(|_| "That video could not be found.".to_string())?;
    let home = home_dir()?;
    if !real.starts_with(&home) {
        return Err("The video has to be inside your home folder, such as Movies or Desktop.".into());
    }
    Ok(real)
}

fn home_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "Could not find your home folder.".to_string())?;
    Ok(PathBuf::from(home))
}

fn export_destination(name: &str) -> Result<PathBuf, String> {
    let dir = if let Ok(custom) = std::env::var("MOVIE_EXPORT_DIR") {
        PathBuf::from(custom)
    } else {
        home_dir()?.join("Movies")
    };
    fs::create_dir_all(&dir).map_err(|_| "Could not create the Movies folder.".to_string())?;
    let stem = clean_name(name)?.1;
    let mut dest = dir.join(format!("{stem}.mp4"));
    let mut number = 2;
    while dest.exists() {
        dest = dir.join(format!("{stem}-{number}.mp4"));
        number += 1;
        if number > 50 {
            return Err("There are already many copies of that movie in Movies.".into());
        }
    }
    Ok(dest)
}

fn next_id(clips: &[Clip]) -> String {
    format!("c{}", next_number(clips) + 1)
}

fn next_number(clips: &[Clip]) -> usize {
    clips.iter().filter_map(|clip| clip.id.strip_prefix('c')?.parse::<usize>().ok()).max().unwrap_or(0)
}

fn project_path(root: &Path, slug: &str) -> PathBuf {
    root.join(slug).join("project.json")
}

fn current_path(root: &Path) -> PathBuf {
    root.join("current")
}

fn write_current(root: &Path, slug: &str) -> Result<(), String> {
    fs::write(current_path(root), slug).map_err(|_| "Could not remember which movie is open.".to_string())
}

fn load_current(root: &Path) -> Result<Project, String> {
    let slug = fs::read_to_string(current_path(root)).map_err(|_| {
        "No movie is open. Say new movie called, then a name.".to_string()
    })?;
    let slug = slug.trim();
    if slug.is_empty() || slug.contains('/') || slug.contains("..") {
        return Err("No movie is open. Say new movie called, then a name.".into());
    }
    read_project(&project_path(root, slug))
}

fn read_project(path: &Path) -> Result<Project, String> {
    let text = fs::read_to_string(path).map_err(|_| "That movie could not be opened.".to_string())?;
    serde_json::from_str(&text).map_err(|_| "That movie file is damaged.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// MOVIE_EXPORT_DIR is shared by every test, so tests that export take turns.
    static EXPORT_DIR: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Each test gets its own folder. Tests run at the same time.
    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("movie-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample(dir: &Path) -> PathBuf {
        let dest = dir.join("sample.mp4");
        let status = Command::new(export::ffmpeg_bin())
            .args([
                "-y", "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2",
                "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
            ])
            .arg(&dest)
            .status()
            .expect("ffmpeg should start");
        assert!(status.success(), "ffmpeg could not make the sample");
        dest
    }

    #[test]
    fn atempo_splits_speeds_ffmpeg_accepts() {
        assert_eq!(export::atempo_chain(1.0), "");
        assert_eq!(export::atempo_chain(2.0), "atempo=2.0000");
        assert_eq!(export::atempo_chain(4.0), "atempo=2.0000,atempo=2.0000");
        assert_eq!(export::atempo_chain(0.25), "atempo=0.5000,atempo=0.5000");
    }

    #[test]
    fn cut_and_undo_change_the_length() {
        let root = scratch("cut_and_undo_change_the_length");
        let video = sample(&root);
        apply(&root, &json!({"op":"new","name":"Trip"}).to_string()).unwrap();
        apply(&root, &json!({"op":"add","file": video}).to_string()).unwrap();
        let cut = apply(&root, &json!({"op":"cut_start","seconds":0.5}).to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&cut).unwrap();
        let seconds = parsed["project"]["seconds"].as_f64().unwrap();
        assert!(seconds > 1.2 && seconds < 1.8, "length after the cut was {seconds}");
        let undone = apply(&root, &json!({"op":"undo"}).to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&undone).unwrap();
        let seconds = parsed["project"]["seconds"].as_f64().unwrap();
        assert!(seconds > 1.7 && seconds < 2.3, "undo length was {seconds}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn remove_middle_splits_one_clip_and_export_writes_a_file() {
        let root = scratch("remove_middle_splits_one_clip_and_export_writes_a_file");
        let video = sample(&root);
        apply(&root, &json!({"op":"new","name":"Trip"}).to_string()).unwrap();
        apply(&root, &json!({"op":"add","file": video}).to_string()).unwrap();
        let reply = apply(&root, &json!({"op":"remove","from":0.5,"to":1.0}).to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(parsed["project"]["clips"].as_array().unwrap().len(), 2);
        let out_dir = root.join("out");
        let _turn = EXPORT_DIR.lock().unwrap_or_else(|err| err.into_inner());
        std::env::set_var("MOVIE_EXPORT_DIR", &out_dir);
        let exported = apply(&root, &json!({"op":"export"}).to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&exported).unwrap();
        assert_eq!(parsed["ok"], true);
        let path = parsed["project"]["exportPath"].as_str().unwrap();
        assert!(Path::new(path).is_file(), "missing {path}");
        std::env::remove_var("MOVIE_EXPORT_DIR");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_photo_becomes_a_still_clip_and_exports() {
        let root = scratch("photo");
        let photo = root.join("beach.png");
        let status = Command::new(export::ffmpeg_bin())
            .args(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=orange:s=640x480", "-frames:v", "1"])
            .arg(&photo)
            .status()
            .expect("ffmpeg should start");
        assert!(status.success());
        let video = sample(&root);
        apply(&root, &json!({"op":"new","name":"Photos"}).to_string()).unwrap();
        apply(&root, &json!({"op":"add","file": video}).to_string()).unwrap();
        let reply = apply(&root, &json!({"op":"add","file": photo}).to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&reply).unwrap();
        let clip = &parsed["project"]["clips"][1];
        assert_eq!(clip["still"], true);
        assert!(clip["path"].as_str().unwrap().ends_with(".jpg"));
        assert_eq!(parsed["project"]["seconds"], 6.0);
        let _turn = EXPORT_DIR.lock().unwrap_or_else(|err| err.into_inner());
        std::env::set_var("MOVIE_EXPORT_DIR", root.join("out"));
        let exported = apply(&root, &json!({"op":"export"}).to_string()).unwrap();
        std::env::remove_var("MOVIE_EXPORT_DIR");
        let parsed: Value = serde_json::from_str(&exported).unwrap();
        assert!(Path::new(parsed["project"]["exportPath"].as_str().unwrap()).is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn transitions_rotation_zoom_and_music_keep_the_length() {
        let root = scratch("everything");
        let video = sample(&root);
        let photo = root.join("beach.png");
        let song = root.join("song.wav");
        for (args, dest) in [
            (vec!["-f", "lavfi", "-i", "color=c=orange:s=480x640", "-frames:v", "1"], &photo),
            (vec!["-f", "lavfi", "-i", "sine=frequency=330:duration=3"], &song),
        ] {
            let status = Command::new(export::ffmpeg_bin())
                .args(["-y", "-hide_banner", "-loglevel", "error"])
                .args(args)
                .arg(dest)
                .status()
                .expect("ffmpeg should start");
            assert!(status.success());
        }
        let run = |order: Value| apply(&root, &order.to_string()).unwrap();
        run(json!({"op":"new","name":"Everything"}));
        run(json!({"op":"add","file": video}));
        run(json!({"op":"add","file": photo}));
        run(json!({"op":"add","file": video, "first": true}));
        run(json!({"op":"rotate","clip":2,"degrees":90}));
        run(json!({"op":"transition","kind":"crossfade","seconds":0.5}));
        run(json!({"op":"music","file": song}));
        run(json!({"op":"caption","text":"Hello, 100 percent","from":1.0,"to":3.0}));
        let reply: Value = serde_json::from_str(&run(json!({"op":"status"}))).unwrap();
        assert_eq!(reply["project"]["seconds"], 8.0);
        assert_eq!(reply["project"]["transition"], "crossfade");
        assert_eq!(reply["project"]["clips"][1]["rotate"], 90);
        assert_eq!(reply["project"]["music"]["name"], "song.wav");

        let _turn = EXPORT_DIR.lock().unwrap_or_else(|err| err.into_inner());
        std::env::set_var("MOVIE_EXPORT_DIR", root.join("out"));
        let exported: Value = serde_json::from_str(&run(json!({"op":"export"}))).unwrap();
        std::env::remove_var("MOVIE_EXPORT_DIR");
        let file = exported["project"]["exportPath"].as_str().unwrap().to_string();
        let probe = Command::new(export::ffprobe_bin())
            .args(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0"])
            .arg(&file)
            .output()
            .unwrap();
        let seconds: f64 = String::from_utf8_lossy(&probe.stdout).trim().parse().unwrap();
        assert!((seconds - 8.0).abs() < 0.15, "the movie is {seconds} seconds");

        run(json!({"op":"undo"}));
        let undone: Value = serde_json::from_str(&run(json!({"op":"undo"}))).unwrap();
        assert!(undone["project"]["captions"].as_array().unwrap().is_empty());
        assert!(undone["project"]["music"].is_null());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn frame_size_can_be_undone_and_a_styled_clip_exports() {
        let root = scratch("frame_size_can_be_undone_and_a_styled_clip_exports");
        let run = |order: Value| apply(&root, &order.to_string()).unwrap();
        run(json!({"op":"new","name":"Trip"}));
        let portrait: Value = serde_json::from_str(&run(json!({"op":"frame","kind":"portrait"}))).unwrap();
        assert_eq!(portrait["project"]["width"], 1080);
        assert_eq!(portrait["project"]["height"], 1920);
        let undone: Value = serde_json::from_str(&run(json!({"op":"undo"}))).unwrap();
        assert_eq!(undone["project"]["width"], 1920);
        assert_eq!(undone["project"]["height"], 1080);
        let redone: Value = serde_json::from_str(&run(json!({"op":"redo"}))).unwrap();
        assert_eq!(redone["project"]["height"], 1920);
        run(json!({"op":"frame","kind":"square"}));
        let stuck = apply(&root, &json!({"op":"redo"}).to_string());
        assert!(stuck.unwrap_err().contains("nothing to redo"));

        let video = sample(&root);
        run(json!({"op":"add","file": video}));
        run(json!({"op":"scale","clip":1,"scale":0.5}));
        run(json!({"op":"mask","clip":1,"kind":"circle"}));
        run(json!({"op":"background","color":"blue"}));
        run(json!({"op":"bars","on":true}));
        let out_dir = root.join("out");
        let _turn = EXPORT_DIR.lock().unwrap_or_else(|err| err.into_inner());
        std::env::set_var("MOVIE_EXPORT_DIR", &out_dir);
        let exported: Value = serde_json::from_str(&run(json!({"op":"export"}))).unwrap();
        std::env::remove_var("MOVIE_EXPORT_DIR");
        let file = exported["project"]["exportPath"].as_str().unwrap();
        let probe = Command::new(export::ffprobe_bin())
            .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0"])
            .arg(file)
            .output()
            .unwrap();
        let size = String::from_utf8_lossy(&probe.stdout);
        assert!(size.contains("1080,1080"), "exported frame was {size}");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_clip_can_move_before_another_and_captions_follow() {
        let root = scratch("order");
        let video = sample(&root);
        let run = |order: Value| apply(&root, &order.to_string()).unwrap();
        run(json!({"op":"new","name":"Order"}));
        for _ in 0..3 {
            run(json!({"op":"add","file": video}));
        }
        // Clips are 2 seconds each. A caption on the third clip, and one on the first.
        run(json!({"op":"caption","text":"third","from":4.5,"to":5.5}));
        run(json!({"op":"caption","text":"first","from":0.5,"to":1.5}));
        let reply: Value = serde_json::from_str(&run(json!({"op":"move_clip","clip":3,"place":"before","target":1}))).unwrap();
        assert_eq!(reply["said"], "Moved sample.mp4. It is clip 1 now.");
        let caps = reply["project"]["captions"].as_array().unwrap();
        let third = caps.iter().find(|c| c["text"] == "third").unwrap();
        let first = caps.iter().find(|c| c["text"] == "first").unwrap();
        assert!((third["start"].as_f64().unwrap() - 0.5).abs() < 0.01, "{third}");
        assert!((first["start"].as_f64().unwrap() - 2.5).abs() < 0.01, "{first}");
        let reply: Value = serde_json::from_str(&run(json!({"op":"move_clip","clip":1,"place":"later"}))).unwrap();
        assert_eq!(reply["said"], "Moved sample.mp4 one step later. It is clip 2 now.");
        let reply: Value = serde_json::from_str(&run(json!({"op":"move_clip","clip":3,"place":"later"}))).unwrap();
        assert_eq!(reply["said"], "That clip is already last.");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_outside_home_is_refused() {
        let root = scratch("a_file_outside_home_is_refused");
        apply(&root, &json!({"op":"new","name":"Trip"}).to_string()).unwrap();
        let err = apply(&root, &json!({"op":"add","file":"/etc/hosts"}).to_string()).unwrap_err();
        assert!(err.contains("home folder") || err.contains("could not be found"), "{err}");
        let _ = fs::remove_dir_all(&root);
    }
}
