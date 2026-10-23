//! Asks ffmpeg to turn the timeline into one mp4.
//!
//! Each clip is trimmed, sped up or slowed down, turned, and padded to the same size.
//! The clips are then joined, straight or with a transition. Fades and captions are
//! drawn on the joined picture. Music goes under the sound and dips when people talk.
//!
//! A transition is centred on the cut, so the movie keeps its length: each clip runs
//! half a transition past the cut. It uses the trimmed-off part of the video when
//! there is one, and holds the first or last frame when there is not.
//! ffmpeg is the same media program OpenCut's setup crate downloads.

use crate::{transition_at, Clip, Project};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Writes `dest`. The caller picks the folder (normally ~/Movies).
pub(crate) fn render(project: &Project, dest: &Path) -> Result<(), String> {
    if project.clips.is_empty() {
        return Err("Add a video before making the movie.".into());
    }
    for clip in &project.clips {
        if !Path::new(&clip.path).is_file() {
            return Err(format!("The video {} is missing. Add it again.", clip.name));
        }
    }
    let total = project.length();
    if total < 0.1 {
        return Err("The movie is too short to make a file.".into());
    }
    if project.fade_in + project.fade_out > total {
        return Err("The fades are longer than the movie. Say a shorter fade.".into());
    }

    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Could not create the Movies folder.".to_string())?;
    }

    let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into(), "-loglevel".into(), "error".into()];
    for clip in &project.clips {
        if clip.still {
            // A photo is one frame. Repeat it for as long as the clip lasts,
            // plus room for a transition at either end.
            args.extend(["-loop".into(), "1".into(), "-framerate".into(), project.fps.to_string()]);
            args.extend(["-t".into(), format!("{:.3}", clip.end + 3.0 * project.speed + 0.5)]);
        }
        args.push("-i".into());
        args.push(clip.path.clone());
    }
    if let Some(music) = &project.music {
        if !Path::new(&music.path).is_file() {
            return Err(format!("The music {} is missing. Add it again.", music.name));
        }
        args.extend(["-stream_loop".into(), "-1".into(), "-i".into(), music.path.clone()]);
    }
    // Homebrew's ffmpeg has no drawtext, so each caption is a picture laid on top.
    let pictures = CaptionPictures::make(project)?;
    for file in &pictures.files {
        args.extend(["-loop".into(), "1".into(), "-framerate".into(), project.fps.to_string()]);
        args.extend(["-t".into(), format!("{total:.3}"), "-i".into(), file.to_string_lossy().into_owned()]);
    }

    let filter = filter_graph(project, total)?;
    args.push("-filter_complex".into());
    args.push(filter);
    args.extend(["-map".into(), "[vout]".into(), "-map".into(), "[aout]".into()]);
    args.extend([
        "-c:v".into(), "libx264".into(),
        "-preset".into(), "veryfast".into(),
        "-crf".into(), "20".into(),
        "-pix_fmt".into(), "yuv420p".into(),
        "-c:a".into(), "aac".into(),
        "-b:a".into(), "160k".into(),
        "-movflags".into(), "+faststart".into(),
    ]);
    args.push(dest.to_string_lossy().into_owned());

    let output = Command::new(ffmpeg_bin())
        .args(&args)
        .output()
        .map_err(|_| "ffmpeg is not installed. Install it with Homebrew, then try again.".to_string())?;
    drop(pictures);
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    let line = detail.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("ffmpeg stopped.");
    let line = line.trim();
    let line = if line.len() > 240 { &line[line.len() - 240..] } else { line };
    Err(format!("Could not make the movie. ffmpeg said: {line}"))
}

/// How long each transition really is. It cannot be longer than the shortest clip.
fn transition_len(project: &Project) -> f64 {
    if project.transition.is_empty() || project.clips.len() < 2 {
        return 0.0;
    }
    let shortest = project.clips.iter().map(|clip| clip_out_len(clip, project)).fold(f64::INFINITY, f64::min);
    project.transition_seconds.min(shortest).max(0.0)
}

/// Seconds a clip runs before and after its own part of the movie, for the transitions.
struct Handles {
    pre: f64,
    post: f64,
}

fn filter_graph(project: &Project, total: f64) -> Result<String, String> {
    let mut parts: Vec<String> = Vec::new();
    let count = project.clips.len();
    let overlap = transition_len(project);
    for (index, clip) in project.clips.iter().enumerate() {
        let handles = Handles {
            pre: if index > 0 { overlap / 2.0 } else { 0.0 },
            post: if index + 1 < count { overlap / 2.0 } else { 0.0 },
        };
        parts.push(video_chain(index, clip, project, &handles));
        parts.push(audio_chain(index, clip, project, &handles));
    }

    if overlap > 0.0 {
        let mut video = "[v0]".to_string();
        let mut audio = "[a0]".to_string();
        let mut made = clip_out_len(&project.clips[0], project) + overlap / 2.0;
        for index in 1..count {
            let offset = made - overlap;
            let (vnext, anext) = if index + 1 == count {
                ("[vc]".to_string(), "[ac]".to_string())
            } else {
                (format!("[vx{index}]"), format!("[ax{index}]"))
            };
            parts.push(format!(
                "{video}[v{index}]xfade=transition={xfade}:duration={overlap:.3}:offset={offset:.3}{vnext}",
                xfade = transition_at(project, index),
            ));
            parts.push(format!("{audio}[a{index}]acrossfade=d={overlap:.3}:c1=tri:c2=tri{anext}"));
            let pre = overlap / 2.0;
            let post = if index + 1 < count { overlap / 2.0 } else { 0.0 };
            made += pre + clip_out_len(&project.clips[index], project) + post - overlap;
            video = vnext;
            audio = anext;
        }
    } else {
        let concat: String = (0..count).map(|index| format!("[v{index}][a{index}]")).collect();
        parts.push(format!("{concat}concat=n={count}:v=1:a=1[vc][ac]"));
    }

    let mut video_label = "[vc]".to_string();
    let mut audio_label = "[ac]".to_string();
    if project.bars {
        let band = ((project.height as f64) * 0.12).round().max(2.0) as u32;
        parts.push(format!(
            "{video_label}drawbox=x=0:y=0:w=iw:h={band}:color=black:t=fill,drawbox=x=0:y=ih-{band}:w=iw:h={band}:color=black:t=fill[vbars]"
        ));
        video_label = "[vbars]".into();
    }
    if project.fade_in > 0.0 || project.fade_out > 0.0 {
        let fade_out_at = (total - project.fade_out).max(0.0);
        let mut vfilters: Vec<String> = Vec::new();
        let mut afilters: Vec<String> = Vec::new();
        if project.fade_in > 0.0 {
            vfilters.push(format!("fade=t=in:st=0:d={:.3}", project.fade_in));
            afilters.push(format!("afade=t=in:st=0:d={:.3}", project.fade_in));
        }
        if project.fade_out > 0.0 {
            vfilters.push(format!("fade=t=out:st={fade_out_at:.3}:d={:.3}", project.fade_out));
            afilters.push(format!("afade=t=out:st={fade_out_at:.3}:d={:.3}", project.fade_out));
        }
        // [vc]fade=...[vf] is one ffmpeg filter chain. The label is already in video_label.
        if !vfilters.is_empty() {
            parts.push(format!("{video_label}{}[vf]", vfilters.join(",")));
            video_label = "[vf]".into();
        }
        if !afilters.is_empty() {
            parts.push(format!("{audio_label}{}[af]", afilters.join(",")));
            audio_label = "[af]".into();
        }
    }

    if let Some(music) = &project.music {
        // The song loops, is cut to the movie, and fades out over the last 2 seconds.
        // sidechaincompress turns it down while the clips' own sound is loud.
        let tail = 2.0_f64.min(total / 2.0);
        parts.push(format!(
            "[{count}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=0:{total:.3},asetpts=PTS-STARTPTS,volume={:.3},afade=t=out:st={:.3}:d={tail:.3}[mus]",
            music.volume,
            total - tail,
        ));
        parts.push(format!("{audio_label}asplit=2[amain][akey]"));
        parts.push("[mus][akey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=500[mduck]".into());
        parts.push("[amain][mduck]amix=inputs=2:duration=first:normalize=0[amix]".into());
        audio_label = "[amix]".into();
    }
    // No clipping when the music and the voices add up. loudnorm is not used:
    // on a silent movie it writes NaN and the aac encoder stops.
    parts.push(format!("{audio_label}alimiter=limit=0.9:level=disabled,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]"));

    if project.captions.is_empty() {
        parts.push(format!("{video_label}null[vout]"));
        return Ok(parts.join(";"));
    }

    // The caption pictures come after the clips and the music.
    let first_input = count + usize::from(project.music.is_some());
    let mut chain = video_label;
    for (index, caption) in project.captions.iter().enumerate() {
        let next = if index + 1 == project.captions.len() {
            "[vout]".to_string()
        } else {
            format!("[cap{index}]")
        };
        let (start, end) = (caption.start, caption.end);
        // Each caption fades in and out over a fifth of a second.
        let fade = (0.2_f64).min((end - start) / 2.0);
        parts.push(format!(
            "[{input}:v]format=rgba,fade=t=in:st={start:.3}:d={fade:.3}:alpha=1,fade=t=out:st={out:.3}:d={fade:.3}:alpha=1[ci{index}]",
            input = first_input + index,
            out = end - fade,
        ));
        // Commas inside enable= must be escaped, because commas also separate filters.
        parts.push(format!(
            "{chain}[ci{index}]overlay=x=(W-w)/2:y=H-h-90:enable=between(t\\,{start:.3}\\,{end:.3}){next}"
        ));
        chain = next;
    }
    Ok(parts.join(";"))
}

/// One PNG per caption, white words on a dark box. Deleted when the export ends.
struct CaptionPictures {
    dir: Option<PathBuf>,
    files: Vec<PathBuf>,
}

impl CaptionPictures {
    fn make(project: &Project) -> Result<Self, String> {
        if project.captions.is_empty() {
            return Ok(Self { dir: None, files: Vec::new() });
        }
        let magick = ["/opt/homebrew/bin/magick", "/usr/local/bin/magick"]
            .into_iter()
            .find(|path| Path::new(path).is_file())
            .ok_or_else(|| "Captions need ImageMagick. Install it with: brew install imagemagick".to_string())?;
        let font = font_path().ok_or_else(|| "Captions need a font, and Arial was not found on this Mac.".to_string())?;
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("moviecut-captions-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|_| "Could not make the captions.".to_string())?;
        let mut pictures = Self { dir: Some(dir.clone()), files: Vec::new() };
        for (index, caption) in project.captions.iter().enumerate() {
            let file = dir.join(format!("{index}.png"));
            let output = Command::new(magick)
            .args(["-background", "rgba(0,0,0,0.5)", "-fill"])
            .arg(safe_color(&project.caption_color))
            .arg("-font")
            .arg(&font)
            .args(["-pointsize", &project.caption_size.to_string(), "-gravity", "center"])
                .arg(format!("label:{}", label_text(&caption.text)))
                .args(["-bordercolor", "rgba(0,0,0,0.5)", "-border", "22x12"])
                .arg(format!("PNG32:{}", file.to_string_lossy()))
                .output()
                .map_err(|_| "Could not make the captions.".to_string())?;
            if !output.status.success() || !file.is_file() {
                return Err(format!("Could not draw the caption {}.", caption.text));
            }
            pictures.files.push(file);
        }
        Ok(pictures)
    }
}

impl Drop for CaptionPictures {
    fn drop(&mut self) {
        if let Some(dir) = &self.dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// ImageMagick reads % as a code and a leading @ as a file name. Long lines break in two.
fn label_text(text: &str) -> String {
    let text = text.replace('%', "%%").replace('\\', "");
    let text = text.trim_start_matches('@').to_string();
    if text.chars().count() <= 42 {
        return text;
    }
    let middle = text.len() / 2;
    let split = text
        .match_indices(' ')
        .map(|(at, _)| at)
        .min_by_key(|at| at.abs_diff(middle));
    match split {
        Some(at) => format!("{}\n{}", &text[..at], &text[at + 1..]),
        None => text,
    }
}

/// transpose turns a picture a quarter turn. 1 is clockwise, 2 is anticlockwise.
fn rotate_filter(degrees: u32) -> &'static str {
    match degrees {
        90 => "transpose=1,",
        180 => "hflip,vflip,",
        270 => "transpose=2,",
        _ => "",
    }
}

fn play_speed(clip: &Clip, project: &Project) -> f64 {
    let rate = if clip.rate <= 0.0 { 1.0 } else { clip.rate };
    project.speed * rate
}

fn clip_out_len(clip: &Clip, project: &Project) -> f64 {
    ((clip.end - clip.start) / play_speed(clip, project)).max(0.0)
}

fn nearly(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.02
}

fn safe_color(color: &str) -> String {
    if !color.is_empty() && color.chars().all(|c| c.is_ascii_lowercase()) {
        color.to_string()
    } else {
        "black".into()
    }
}

fn even_dim(value: f64, cap: u32) -> u32 {
    let n = value.round().clamp(2.0, cap as f64) as u32;
    n - n % 2
}

/// A clip that is just fitted into the frame. The simple filter is enough.
fn plain_look(clip: &Clip, project: &Project) -> bool {
    !clip.hidden
        && !project.blur_background
        && clip.blur < 0.5
        && clip.mask.is_empty()
        && clip.blend.is_empty()
        && nearly(clip.scale, 1.0)
        && nearly(clip.stretch, 1.0)
        && clip.shift_x.abs() < 0.01
        && clip.shift_y.abs() < 0.01
        && clip.opacity > 0.99
}

fn video_chain(index: usize, clip: &Clip, project: &Project, handles: &Handles) -> String {
    let speed = play_speed(clip, project);
    let (w, h, fps) = (project.width, project.height, project.fps);
    let out_len = clip_out_len(clip, project) + handles.pre + handles.post;
    let bg = safe_color(&project.background);
    if clip.hidden {
        return format!(
            "color=c={bg}:s={w}x{h}:r={fps}:d={out_len:.3},format=yuv420p,settb=AVTB[v{index}]"
        );
    }
    let room_after = if clip.still { f64::INFINITY } else { (clip.duration - clip.end).max(0.0) };
    let take_pre = (handles.pre * speed).min(clip.start);
    let take_post = (handles.post * speed).min(room_after);
    let hold_pre = handles.pre - take_pre / speed;
    let hold_post = handles.post - take_post / speed;
    let trim = format!(
        "[{index}:v]trim=start={:.3}:end={:.3},setpts=(PTS-STARTPTS)/{speed:.4},{}",
        clip.start - take_pre,
        clip.end + take_post,
        rotate_filter(clip.rotate),
    );
    let hold = if hold_pre > 0.001 || hold_post > 0.001 {
        format!(",tpad=start_duration={hold_pre:.3}:start_mode=clone:stop_duration={hold_post:.3}:stop_mode=clone")
    } else {
        String::new()
    };
    let ken = plain_look(clip, project)
        && !clip.zoom_off
        && (clip.zoom || (clip.still && project.photo_zoom));
    if ken {
        let frames = (out_len * fps as f64).round().max(1.0);
        let (w2, h2) = (w * 2, h * 2);
        return format!(
            "{trim}fps={fps}{hold},scale={w2}:{h2}:force_original_aspect_ratio=decrease,pad={w2}:{h2}:(ow-iw)/2:(oh-ih)/2:color={bg},zoompan=z='1+0.08*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s={w}x{h}:fps={fps},format=yuv420p,settb=AVTB[v{index}]"
        );
    }
    if plain_look(clip, project) {
        return format!(
            "{trim}scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color={bg},fps={fps},format=yuv420p{hold},settb=AVTB[v{index}]"
        );
    }

    // The clip is smaller, moved, blurred, masked, or sitting on a blurred background.
    let box_w = even_dim(w as f64 * clip.scale * clip.stretch, w * 2);
    let box_h = even_dim(h as f64 * clip.scale / clip.stretch.max(0.2), h * 2);
    let fit = if nearly(clip.stretch, 1.0) {
        format!("scale={box_w}:{box_h}:force_original_aspect_ratio=decrease")
    } else {
        format!("scale={box_w}:{box_h}")
    };
    let blur = if clip.blur >= 0.5 {
        format!(",boxblur={}:1", clip.blur.round().clamp(1.0, 20.0) as i32)
    } else {
        String::new()
    };
    // A circle of the clip. Commas inside geq are escaped so they are not filter breaks.
    let mask = if clip.mask == "circle" {
        ",format=yuva420p,geq=lum='p(X,Y)':a='if(lte(pow(X-W/2\\,2)+pow(Y-H/2\\,2)\\,pow(min(W\\,H)/2\\,2))\\,255\\,0)'"
    } else {
        ""
    };
    let opacity = if clip.opacity < 0.99 {
        format!(",format=yuva420p,colorchannelmixer=aa={:.3}", clip.opacity.clamp(0.0, 1.0))
    } else {
        String::new()
    };
    let fg = format!("{trim}fps={fps}{hold}{blur},{fit}{mask}{opacity}[fg{index}]");
    let plate = if project.blur_background {
        format!("{trim}fps={fps}{hold},scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},boxblur=18:2[bg{index}]")
    } else {
        format!("color=c={bg}:s={w}x{h}:r={fps}:d={out_len:.3}[bg{index}]")
    };
    let dx = (clip.shift_x * w as f64).round() as i32;
    let dy = (clip.shift_y * h as f64).round() as i32;
    let ox = if dx >= 0 { format!("(W-w)/2+{dx}") } else { format!("(W-w)/2{dx}") };
    let oy = if dy >= 0 { format!("(H-h)/2+{dy}") } else { format!("(H-h)/2{dy}") };
    let placed = format!(
        "{plate};{fg};[bg{index}][fg{index}]overlay=x='{ox}':y='{oy}':format=auto[pl{index}]"
    );
    if clip.blend.is_empty() {
        return format!("{placed};[pl{index}]format=yuv420p,settb=AVTB[v{index}]");
    }
    format!(
        "{placed};color=c={bg}:s={w}x{h}:r={fps}:d={out_len:.3}[tn{index}];[pl{index}][tn{index}]blend=all_mode={}:shortest=1,format=yuv420p,settb=AVTB[v{index}]",
        clip.blend
    )
}

fn audio_chain(index: usize, clip: &Clip, project: &Project, handles: &Handles) -> String {
    let speed = play_speed(clip, project);
    let gain = if clip.clip_muted || clip.hidden { 0.0 } else { clip.clip_volume.max(0.0) };
    let volume = if project.muted { 0.0 } else { project.volume * gain };
    let tempo = atempo_chain(speed);
    let tempo = if tempo.is_empty() { String::new() } else { format!("{tempo},") };
    let out_len = clip_out_len(clip, project) + handles.pre + handles.post;
    if !clip.has_audio {
        // A silent clip still needs an audio track so the clips can be joined.
        return format!(
            "anullsrc=r=48000:cl=stereo,atrim=0:{out_len:.3},asetpts=PTS-STARTPTS,volume={volume:.3}[a{index}]"
        );
    }
    let take_pre = (handles.pre * speed).min(clip.start);
    let take_post = (handles.post * speed).min((clip.duration - clip.end).max(0.0));
    let quiet_pre = handles.pre - take_pre / speed;
    // Silence where the picture holds a frame, so sound and picture stay together.
    let delay = if quiet_pre > 0.001 {
        format!(",adelay=delays={}:all=1", (quiet_pre * 1000.0).round() as i64)
    } else {
        String::new()
    };
    format!(
        "[{index}:a]atrim=start={:.3}:end={:.3},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,{tempo}volume={volume:.3}{delay},apad=whole_dur={out_len:.3},atrim=0:{out_len:.3}[a{index}]",
        clip.start - take_pre,
        clip.end + take_post,
    )
}

/// ffmpeg's atempo filter only accepts 0.5 to 2. Bigger changes are several steps.
pub fn atempo_chain(speed: f64) -> String {
    if (speed - 1.0).abs() < 0.001 {
        return String::new();
    }
    let mut factors = Vec::new();
    let mut rest = speed;
    if rest > 1.0 {
        while rest > 2.0 + 0.001 {
            factors.push(2.0);
            rest /= 2.0;
        }
        factors.push(rest);
    } else {
        while rest < 0.5 - 0.001 {
            factors.push(0.5);
            rest /= 0.5;
        }
        factors.push(rest);
    }
    factors.into_iter().map(|factor| format!("atempo={factor:.4}")).collect::<Vec<_>>().join(",")
}

fn font_path() -> Option<PathBuf> {
    [
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|path| path.is_file())
}

pub fn ffmpeg_bin() -> String {
    if let Ok(path) = std::env::var("MOVIE_FFMPEG") {
        if !path.is_empty() && Path::new(&path).is_file() {
            return path;
        }
    }
    if Path::new("/opt/homebrew/bin/ffmpeg").is_file() {
        return "/opt/homebrew/bin/ffmpeg".into();
    }
    "ffmpeg".into()
}

pub fn ffprobe_bin() -> String {
    if let Ok(path) = std::env::var("MOVIE_FFPROBE") {
        if !path.is_empty() && Path::new(&path).is_file() {
            return path;
        }
    }
    if Path::new("/opt/homebrew/bin/ffprobe").is_file() {
        return "/opt/homebrew/bin/ffprobe".into();
    }
    "ffprobe".into()
}
