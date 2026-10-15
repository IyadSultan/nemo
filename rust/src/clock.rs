//! Spoken times and dates, from `second-brain/server.js`
//! (numberWord, spokenYear, spokenClock, spokenDay, hereAndNow).
//! The voice reads these aloud, so "21:11" becomes "nine eleven in the evening".

use chrono::{DateTime, Datelike, Local, TimeZone, Timelike};

const SMALL_WORDS: [&str; 20] = [
    "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
    "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const DAY_WORDS: [&str; 32] = [
    "", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh",
    "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth",
    "twentieth", "twenty-first", "twenty-second", "twenty-third", "twenty-fourth", "twenty-fifth", "twenty-sixth",
    "twenty-seventh", "twenty-eighth", "twenty-ninth", "thirtieth", "thirty-first",
];
pub const MONTH_NAMES: [&str; 12] = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
    "December",
];

/// 0–59 in words.
pub fn number_word(n: u32) -> String {
    if n < 20 {
        return SMALL_WORDS[n as usize].into();
    }
    let tens = ["", "", "twenty", "thirty", "forty", "fifty"][(n / 10) as usize];
    match n % 10 {
        0 => tens.into(),
        one => format!("{tens}-{}", SMALL_WORDS[one as usize]),
    }
}

pub fn spoken_year(year: i32) -> String {
    if (2000..2100).contains(&year) {
        let rest = (year - 2000) as u32;
        return match rest {
            0 => "two thousand".into(),
            1..=9 => format!("two thousand {}", number_word(rest)),
            _ => format!("twenty {}", number_word(rest)),
        };
    }
    year.to_string()
}

/// A clock time in words, so the voice does not read 21:11 as a code.
pub fn spoken_clock<T: TimeZone>(date: &DateTime<T>) -> String {
    let (hour24, minute) = (date.hour(), date.minute());
    let part = match hour24 {
        12..=16 => "in the afternoon",
        17..=21 => "in the evening",
        22.. | 0..=4 => "at night",
        _ => "in the morning",
    };
    let hour = match hour24 % 12 {
        0 => 12,
        h => h,
    };
    match minute {
        0 => format!("{} o'clock {part}", number_word(hour)),
        1..=9 => format!("{} oh {} {part}", number_word(hour), number_word(minute)),
        _ => format!("{} {} {part}", number_word(hour), number_word(minute)),
    }
}

/// A date in words. "Oct" is avoided because the voice reads it as "act".
pub fn spoken_day<T: TimeZone>(date: &DateTime<T>) -> String {
    format!(
        "the {} of {}, {}",
        DAY_WORDS[date.day() as usize],
        MONTH_NAMES[date.month0() as usize],
        spoken_year(date.year())
    )
}

/// The Mac's time zone name, e.g. "Asia/Amman" (TZ, else /etc/localtime).
pub fn zone_name() -> String {
    if let Ok(tz) = std::env::var("TZ") {
        if !tz.is_empty() {
            return tz.trim_start_matches(':').to_string();
        }
    }
    std::fs::read_link("/etc/localtime")
        .ok()
        .and_then(|p| p.to_string_lossy().split("zoneinfo/").nth(1).map(String::from))
        .unwrap_or_else(|| "Asia/Amman".into())
}

/// "It is nine eleven in the evening on Thursday, the fifteenth of October, twenty twenty-six. The place is Amman, Jordan."
pub fn here_and_now(now_ms: i64, zone: &str) -> String {
    let clock = Local.timestamp_millis_opt(now_ms).unwrap();
    let city = if zone == "Asia/Amman" {
        "Amman, Jordan".to_string()
    } else {
        let last = zone.rsplit('/').next().filter(|s| !s.is_empty()).unwrap_or("this Mac");
        last.replace('_', " ")
    };
    format!("It is {} on {}, {}. The place is {city}.", spoken_clock(&clock), clock.format("%A"), spoken_day(&clock))
}
