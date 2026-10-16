/**
 * Dates, times and names in words the voice can read: "the sixteenth of October,
 * twenty twenty-six, at nine eleven in the evening". The here_and_now line comes from here.
 */



export function startOfDayMs(dayOffset = 0) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + dayOffset);
  return start.getTime();
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const MONTH_SHORT = {
  jan: "January", feb: "February", mar: "March", apr: "April",
  jun: "June", jul: "July", aug: "August", sep: "September", sept: "September",
  oct: "October", nov: "November", dec: "December",
};

export const SMALL_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];

export const DAY_WORDS = [
  "", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth",
  "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth",
  "seventeenth", "eighteenth", "nineteenth", "twentieth", "twenty-first", "twenty-second",
  "twenty-third", "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh",
  "twenty-eighth", "twenty-ninth", "thirtieth", "thirty-first",
];

export function numberWord(n) {
  if (n < 20) return SMALL_WORDS[n];
  const ten = Math.floor(n / 10);
  const one = n % 10;
  const tens = ["", "", "twenty", "thirty", "forty", "fifty"];
  return one ? `${tens[ten]}-${SMALL_WORDS[one]}` : tens[ten];
}

export function spokenYear(year) {
  if (year >= 2000 && year < 2100) {
    const rest = year - 2000;
    if (rest === 0) return "two thousand";
    if (rest < 10) return `two thousand ${numberWord(rest)}`;
    return `twenty ${numberWord(rest)}`;
  }
  return String(year);
}

/** A clock time in words, so the voice does not read 21:11 as a code. */
export function spokenClock(date) {
  const hour24 = date.getHours();
  const minute = date.getMinutes();
  let part = "in the morning";
  if (hour24 >= 12 && hour24 < 17) part = "in the afternoon";
  else if (hour24 >= 17 && hour24 < 22) part = "in the evening";
  else if (hour24 >= 22 || hour24 < 5) part = "at night";
  let hour = hour24 % 12;
  if (hour === 0) hour = 12;
  if (minute === 0) return `${numberWord(hour)} o'clock ${part}`;
  if (minute < 10) return `${numberWord(hour)} oh ${numberWord(minute)} ${part}`;
  return `${numberWord(hour)} ${numberWord(minute)} ${part}`;
}

/** A date in words. "Oct" is avoided because the voice reads it as "act". */
export function spokenDay(date) {
  return `the ${DAY_WORDS[date.getDate()]} of ${MONTH_NAMES[date.getMonth()]}, ${spokenYear(date.getFullYear())}`;
}

export function spokenWhen(mtime) {
  const date = new Date(mtime);
  return `${spokenDay(date)}, at ${spokenClock(date)}`;
}

export function speakTitle(title) {
  return String(title || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[_]+/g, " ")
    .replace(/\b(jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b\.?/gi, (match) => {
      const key = match.toLowerCase().replace(/\.$/, "");
      return MONTH_SHORT[key] || match;
    })
    .replace(/(\d{1,2})\s*[-–]\s*(\d{1,2})/g, "$1 to $2")
    .replace(/\s+/g, " ")
    .trim();
}

export function savedLabel(mtime) {
  return spokenWhen(mtime);
}

export function dayLabel(mtime) {
  return spokenDay(new Date(mtime));
}

export function sizeLabel(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kilobytes`;
  return `${(n / (1024 * 1024)).toFixed(1)} megabytes`;
}

export function memoStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-") + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * The here_and_now tool.
 * It reads the Mac clock and says the time and place in full words.
 * The voice reads those words exactly, so this must not use 07:03 or "Oct".
 */
export function hereAndNow() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Amman";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const pick = (type) => parts.find((part) => part.type === type)?.value || "";
  let hour = Number(pick("hour"));
  if (hour === 24) hour = 0;
  const clock = new Date(Number(pick("year")), Number(pick("month")) - 1, Number(pick("day")), hour, Number(pick("minute")));
  const city = timeZone === "Asia/Amman"
    ? "Amman, Jordan"
    : (timeZone.split("/").pop() || "this Mac").replace(/_/g, " ");
  return `It is ${spokenClock(clock)} on ${pick("weekday")}, ${spokenDay(clock)}. The place is ${city}.`;
}

/** The clock on this Mac, so "today" does not depend on a web search. */
export function todayLabel() {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Amman",
  }).format(new Date());
}
