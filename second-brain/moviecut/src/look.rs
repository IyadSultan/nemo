//! Picture, sound, and layout changes for one clip or the whole frame.
//!
//! These are the OpenCut Classic controls this editor can do with ffmpeg:
//! frame size, background, move, resize, see-through, blur, a circle mask,
//! blend, per-clip sound and speed, hide, duplicate, redo, and captions.

use super::*;

const COLORS: &[&str] = &[
    "black", "white", "blue", "red", "green", "yellow", "orange", "pink", "purple", "gray", "navy", "teal",
];

pub(super) fn normalize_color(color: &str) -> Result<String, String> {
    let color = color.trim().to_lowercase().replace("grey", "gray");
    if COLORS.contains(&color.as_str()) {
        return Ok(color);
    }
    Err(format!("Say a colour: {}.", COLORS.join(", ")))
}

impl Project {
    pub(super) fn set_frame(&mut self, kind: &str) -> Result<String, String> {
        let (width, height, name) = match kind {
            "widescreen" | "landscape" => (1920, 1080, "widescreen"),
            "portrait" | "phone" => (1080, 1920, "portrait, for a phone"),
            "square" => (1080, 1080, "square"),
            "classic" => (1440, 1080, "the classic 4 by 3 size"),
            _ => return Err("Say widescreen, portrait, square, or classic.".into()),
        };
        if self.width == width && self.height == height {
            return Ok(format!("The movie is already {name}."));
        }
        self.change(|project| {
            project.width = width;
            project.height = height;
            Ok(format!("The movie is now {name}, {width} by {height}."))
        })
    }

    pub(super) fn set_background(&mut self, color: &str) -> Result<String, String> {
        let color = normalize_color(color)?;
        if self.background == color {
            return Ok(format!("The background is already {color}."));
        }
        self.change(|project| {
            project.background = color.clone();
            Ok(format!("The background is now {color}."))
        })
    }

    pub(super) fn set_blur_background(&mut self, on: bool) -> String {
        if self.blur_background == on {
            return if on { "The background is already blurred.".into() } else { "The background is already a flat colour.".into() };
        }
        let _ = self.change(|project| {
            project.blur_background = on;
            Ok(String::new())
        });
        if on { "The empty bars are now a blurred copy of the clip.".into() } else { "The background is a flat colour again.".into() }
    }

    pub(super) fn nudge(&mut self, clip_number: usize, way: &str) -> Result<String, String> {
        let index = self.clip_index(clip_number)?;
        let way = way.trim();
        self.change(|project| {
            let clip = &mut project.clips[index];
            match way {
                "left" => clip.shift_x = (clip.shift_x - 0.12).max(-0.45),
                "right" => clip.shift_x = (clip.shift_x + 0.12).min(0.45),
                "up" => clip.shift_y = (clip.shift_y - 0.12).max(-0.45),
                "down" => clip.shift_y = (clip.shift_y + 0.12).min(0.45),
                "center" => {
                    clip.shift_x = 0.0;
                    clip.shift_y = 0.0;
                }
                _ => return Err("Say move the clip left, right, up, down, or to the center.".into()),
            }
            clip.zoom = false;
            Ok(if way == "center" {
                format!("Moved clip {} back to the centre.", index + 1)
            } else {
                format!("Moved clip {} {way}.", index + 1)
            })
        })
    }

    pub(super) fn set_scale(&mut self, clip_number: usize, scale: Option<f64>, how: &str) -> Result<String, String> {
        let index = self.clip_index(clip_number)?;
        let next = if let Some(scale) = scale {
            if !scale.is_finite() || !(0.25..=2.0).contains(&scale) {
                return Err("Say a size from 25 percent to 200 percent.".into());
            }
            scale
        } else {
            let now = self.clips[index].scale;
            match how {
                "bigger" => (now * 1.25).min(2.0),
                "smaller" => (now * 0.8).max(0.25),
                "half" => 0.5,
                "normal" => 1.0,
                _ => return Err("Say make the clip bigger, smaller, half size, or a percent.".into()),
            }
        };
        self.change(|project| {
            let clip = &mut project.clips[index];
            clip.scale = next;
            clip.zoom = false;
            Ok(format!("Clip {} is now {} percent of the frame.", index + 1, (next * 100.0).round() as i64))
        })
    }

    pub(super) fn set_stretch(&mut self, clip_number: usize, how: &str) -> Result<String, String> {
        let index = self.clip_index(clip_number)?;
        let stretch = match how {
            "wide" => 1.4,
            "tall" => 0.7,
            "normal" => 1.0,
            _ => return Err("Say stretch the clip wide, tall, or back to normal.".into()),
        };
        self.change(|project| {
            let clip = &mut project.clips[index];
            clip.stretch = stretch;
            clip.zoom = false;
            Ok(match how {
                "wide" => format!("Stretched clip {} wide.", index + 1),
                "tall" => format!("Stretched clip {} tall.", index + 1),
                _ => format!("Clip {} is back to its own shape.", index + 1),
            })
        })
    }

    pub(super) fn set_opacity(&mut self, clip_number: usize, level: f64) -> Result<String, String> {
        if !level.is_finite() || !(0.0..=1.0).contains(&level) {
            return Err("Say how see-through, from solid down to invisible.".into());
        }
        let index = self.clip_index(clip_number)?;
        self.change(|project| {
            project.clips[index].opacity = level;
            Ok(if level >= 0.99 {
                format!("Clip {} is solid again.", index + 1)
            } else {
                format!("Clip {} is {} percent solid.", index + 1, (level * 100.0).round() as i64)
            })
        })
    }

    pub(super) fn set_clip_muted(&mut self, clip_number: usize, muted: bool) -> Result<String, String> {
        let index = self.clip_index(clip_number)?;
        self.change(|project| {
            project.clips[index].clip_muted = muted;
            Ok(if muted {
                format!("Muted clip {}.", index + 1)
            } else {
                format!("Turned the sound of clip {} back on.", index + 1)
            })
        })
    }

    pub(super) fn set_clip_volume(&mut self, clip_number: usize, level: f64) -> Result<String, String> {
        if !level.is_finite() || !(0.0..=2.0).contains(&level) {
            return Err("Say a clip volume from 0 to 200 percent.".into());
        }
        let index = self.clip_index(clip_number)?;
        self.change(|project| {
            let clip = &mut project.clips[index];
            clip.clip_volume = level;
            clip.clip_muted = false;
            Ok(format!("Clip {} is at {} percent volume.", index + 1, (level * 100.0).round() as i64))
        })
    }

    pub(super) fn set_clip_speed(&mut self, clip_number: usize, rate: f64) -> Result<String, String> {
        if !rate.is_finite() || !(0.25..=4.0).contains(&rate) {
            return Err("A clip's speed has to be between a quarter and 4.".into());
        }
        let index = self.clip_index(clip_number)?;
        let (t0, t1) = self.clip_span(index);
        let old_len = (t1 - t0).max(0.001);
        self.change(|project| {
            project.clips[index].rate = rate;
            let new_len = ((project.clips[index].end - project.clips[index].start) / pace(project.speed, rate)).max(0.0);
            let scale = new_len / old_len;
            let shift = new_len - old_len;
            for caption in project.captions.iter_mut() {
                if caption.end <= t0 + 0.02 {
                    continue;
                }
                if caption.start >= t1 - 0.02 {
                    caption.start += shift;
                    caption.end += shift;
                } else if caption.start >= t0 - 0.02 && caption.end <= t1 + 0.02 {
                    caption.start = t0 + (caption.start - t0) * scale;
                    caption.end = t0 + (caption.end - t0) * scale;
                }
            }
            project.captions.retain(|caption| caption.end - caption.start >= 0.1);
            Ok(format!("Clip {} now plays at {} speed.", index + 1, speed_words(rate)))
        })
    }

    pub(super) fn set_hidden(&mut self, clip_number: usize, hidden: bool) -> Result<String, String> {
        let index = self.clip_index(clip_number)?;
        self.change(|project| {
            project.clips[index].hidden = hidden;
            Ok(if hidden {
                format!("Hid clip {}. It still takes its place. Say show clip {} to bring it back.", index + 1, index + 1)
            } else {
                format!("Clip {} is visible again.", index + 1)
            })
        })
    }

    pub(super) fn duplicate(&mut self, clip_number: usize) -> Result<String, String> {
        let index = self.clip_index(clip_number)?;
        let (t0, t1) = self.clip_span(index);
        let len = t1 - t0;
        self.change(|project| {
            let mut copy = project.clips[index].clone();
            copy.id = next_id(&project.clips);
            let name = copy.name.clone();
            project.clips.insert(index + 1, copy);
            let mut extra = Vec::new();
            for caption in project.captions.iter_mut() {
                if caption.start >= t1 - 0.02 {
                    caption.start += len;
                    caption.end += len;
                } else if caption.start >= t0 - 0.02 && caption.end <= t1 + 0.02 {
                    let mut twin = caption.clone();
                    twin.start += len;
                    twin.end += len;
                    extra.push(twin);
                }
            }
            project.captions.extend(extra);
            Ok(format!("Duplicated {name}. It now plays twice in a row."))
        })
    }

    pub(super) fn set_blur(&mut self, clip_number: usize, amount: f64) -> Result<String, String> {
        let index = self.clip_index(clip_number)?;
        self.change(|project| {
            let clip = &mut project.clips[index];
            clip.zoom = false;
            if amount < 0.0 {
                clip.blur = (clip.blur + 6.0).clamp(8.0, 20.0);
            } else {
                clip.blur = amount.clamp(0.0, 20.0);
            }
            Ok(if clip.blur < 0.5 {
                format!("Clip {} is sharp again.", index + 1)
            } else {
                format!("Blurred clip {}.", index + 1)
            })
        })
    }

    pub(super) fn set_mask(&mut self, clip_number: usize, kind: &str) -> Result<String, String> {
        let kind = match kind {
            "circle" => "circle",
            "none" | "" => "",
            _ => return Err("Say a circle mask, or remove the mask.".into()),
        };
        let index = self.clip_index(clip_number)?;
        self.change(|project| {
            let clip = &mut project.clips[index];
            clip.mask = kind.to_string();
            clip.zoom = false;
            Ok(if kind.is_empty() {
                format!("Removed the mask from clip {}.", index + 1)
            } else {
                format!("Clip {} is now in a circle.", index + 1)
            })
        })
    }

    pub(super) fn set_bars(&mut self, on: bool) -> String {
        if self.bars == on {
            return if on { "The cinema bars are already on.".into() } else { "There are no cinema bars.".into() };
        }
        let _ = self.change(|project| {
            project.bars = on;
            Ok(String::new())
        });
        if on { "Added black bars at the top and bottom.".into() } else { "Removed the cinema bars.".into() }
    }

    pub(super) fn set_blend(&mut self, clip_number: usize, kind: &str) -> Result<String, String> {
        let kind = match kind {
            "multiply" | "screen" | "overlay" => kind,
            "none" | "" => "",
            _ => return Err("Say multiply, screen, overlay, or remove the blend.".into()),
        };
        let index = self.clip_index(clip_number)?;
        self.change(|project| {
            project.clips[index].blend = kind.to_string();
            Ok(if kind.is_empty() {
                format!("Clip {} sits on the background normally.", index + 1)
            } else {
                format!("Clip {} now blends with the background as {kind}.", index + 1)
            })
        })
    }

    pub(super) fn set_clip_zoom(&mut self, clip_number: usize, on: bool) -> Result<String, String> {
        let index = self.clip_index(clip_number)?;
        self.change(|project| {
            let clip = &mut project.clips[index];
            clip.zoom = on;
            clip.zoom_off = !on;
            if on {
                clip.scale = 1.0;
                clip.stretch = 1.0;
                clip.shift_x = 0.0;
                clip.shift_y = 0.0;
            }
            Ok(if on {
                format!("Clip {} now zooms in slowly.", index + 1)
            } else {
                format!("Clip {} stays still.", index + 1)
            })
        })
    }

    pub(super) fn set_caption_style(&mut self, color: &str, size: &str) -> Result<String, String> {
        let color = if color.is_empty() { None } else { Some(normalize_color(color)?) };
        let size = match size {
            "" => None,
            "bigger" => Some((self.caption_size + 12).min(96)),
            "smaller" => Some(self.caption_size.saturating_sub(12).max(28)),
            "normal" => Some(52),
            _ => return Err("Say make the captions bigger, smaller, or a colour.".into()),
        };
        if color.is_none() && size.is_none() {
            return Err("Say a caption colour, or say bigger or smaller.".into());
        }
        self.change(|project| {
            if let Some(color) = color.clone() {
                project.caption_color = color;
            }
            if let Some(size) = size {
                project.caption_size = size;
            }
            Ok(format!("Captions are {} and size {}.", project.caption_color, project.caption_size))
        })
    }

    /// Moves a clip: to the start or end, one step earlier or later, or before or after clip `target`.
    pub(super) fn move_clip(&mut self, clip_number: usize, place: &str, target: usize) -> Result<String, String> {
        let index = self.clip_index(clip_number)?;
        let last = self.clips.len() - 1;
        let dest = match place {
            "start" => 0,
            "end" => last,
            "earlier" => index.saturating_sub(1),
            "later" => (index + 1).min(last),
            "before" | "after" => {
                let other = self.clip_index(target)?;
                if other == index {
                    return Err("That is the same clip.".into());
                }
                // Once the clip is lifted out, everything after it moves up one.
                let shifted = if index < other { other - 1 } else { other };
                if place == "before" { shifted } else { shifted + 1 }
            }
            _ => return Err("Say move the clip to the start, to the end, earlier, later, or before or after another clip.".into()),
        };
        if index == dest {
            return Ok(match place {
                "start" | "earlier" => "That clip is already first.".into(),
                "end" | "later" => "That clip is already last.".into(),
                _ => "That clip is already there.".into(),
            });
        }
        let (t0, t1) = self.clip_span(index);
        let len = t1 - t0;
        self.change(|project| {
            let clip = project.clips.remove(index);
            let name = clip.name.clone();
            project.clips.insert(dest, clip);
            let new_t0 = project.clip_span(dest).0;
            // Captions ride with their clip. The clips the move passed over slide the other way.
            for caption in project.captions.iter_mut() {
                let inside = caption.start >= t0 - 0.02 && caption.end <= t1 + 0.02;
                let shift = if inside {
                    new_t0 - t0
                } else if index < dest && caption.start >= t1 - 0.02 && caption.start < new_t0 + len {
                    -len
                } else if index > dest && caption.start >= new_t0 - 0.02 && caption.start < t0 {
                    len
                } else {
                    0.0
                };
                caption.start = (caption.start + shift).max(0.0);
                caption.end = (caption.end + shift).max(0.0);
            }
            project.captions.retain(|caption| caption.end - caption.start >= 0.1);
            Ok(match place {
                "start" => format!("Moved {name} to the start."),
                "end" => format!("Moved {name} to the end."),
                "earlier" => format!("Moved {name} one step earlier. It is clip {} now.", dest + 1),
                "later" => format!("Moved {name} one step later. It is clip {} now.", dest + 1),
                _ => format!("Moved {name}. It is clip {} now.", dest + 1),
            })
        })
    }

    pub(super) fn reset_look(&mut self, clip_number: usize) -> Result<String, String> {
        let index = self.clip_index(clip_number)?;
        self.change(|project| {
            let clip = &mut project.clips[index];
            clip.scale = 1.0;
            clip.stretch = 1.0;
            clip.shift_x = 0.0;
            clip.shift_y = 0.0;
            clip.opacity = 1.0;
            clip.blur = 0.0;
            clip.mask.clear();
            clip.blend.clear();
            clip.zoom = false;
            clip.zoom_off = false;
            clip.hidden = false;
            Ok(format!("Clip {} is back to a plain full-frame picture.", index + 1))
        })
    }

    pub(super) fn add_bookmark(&mut self, at: f64) -> Result<String, String> {
        let at = check_seconds(at, "Say when to bookmark, such as 10 seconds.")?;
        if self.clips.is_empty() {
            return Err("Add a video first.".into());
        }
        if at > self.length() {
            return Err("That is past the end of the movie.".into());
        }
        self.change(|project| {
            project.bookmarks.push(at);
            if project.bookmarks.len() > 20 {
                project.bookmarks.remove(0);
            }
            Ok(format!("Bookmarked {}.", spoken_len(at)))
        })
    }

    pub(super) fn clear_bookmarks(&mut self) -> String {
        if self.bookmarks.is_empty() {
            return "There are no bookmarks.".into();
        }
        let _ = self.change(|project| {
            project.bookmarks.clear();
            Ok(String::new())
        });
        "Removed the bookmarks.".into()
    }

    pub(super) fn set_guide(&mut self, kind: &str) -> Result<String, String> {
        let kind = match kind {
            "grid" | "phone" => kind,
            "none" | "" => "",
            _ => return Err("Say show the grid, show the phone guide, or hide the guides.".into()),
        };
        self.change(|project| {
            project.guide = kind.to_string();
            Ok(match kind {
                "grid" => "The preview shows a grid. It is not in the exported movie.",
                "phone" => "The preview shows a phone-shaped guide. It is not in the exported movie.",
                _ => "Hid the guides.",
            }.into())
        })
    }
}
