#!/usr/bin/env python3
"""
Hey my brain — always-on wake phrase for the second brain.

What this does, in plain words:
1. It listens to the microphone in short pieces.
2. A small voice model on this Mac (Whisper small, English) turns
   each piece into text. This is the same kind of small speech model
   already used for voice notes: it only writes down what you said.
   It does not answer the question.
3. When it hears "Hey my brain", it keeps listening for the question.
4. It sends that question to the second-brain app on this Mac.
5. The Mac reads the answer out loud.

The voice model stays on your Mac. Only the question text goes to
OpenAI, through the second-brain server, and only after the wake phrase.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG = ROOT / "tmp" / "events.log"
MODEL = ROOT / "models" / "ggml-small.en.bin"
MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"
WHISPER = "/opt/homebrew/bin/whisper-cli"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
BRAIN_URL = "http://127.0.0.1:3001/ask"

# How long each listening slice is. The wake phrase has to land inside
# one slice, or across two slices that we stick together.
CHUNK_SECONDS = 3
# After the wake phrase, keep listening this many extra slices at most.
FOLLOW_CHUNKS = 3

# Whisper sometimes invents these on a quiet room. They are not a question.
SILENCE_LINES = {
    "",
    "you",
    "thank you",
    "thanks for watching",
    "thanks for watching.",
    "subscribe",
    ".",
    "...",
}


def say(event: str, text: str = "") -> None:
    """
    Save one status line and show a Mac notification.

    Hammerspoon cannot read output from a program that keeps running,
    so a popup from here is what you actually see.
    """
    LOG.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps({"event": event, "text": text})
    with LOG.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")
    if event == "heard":
        return
    title = "Hey my brain"
    message = text or event
    script = (
        "display notification "
        + applescript_string(message[:180])
        + " with title "
        + applescript_string(title)
    )
    subprocess.run(["osascript", "-e", script], check=False)


def applescript_string(text: str) -> str:
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def microphone() -> tuple[str, str]:
    """
    Pick the Mac's own microphone.
    Device 0 on this computer is Microsoft Teams, which is silent
    unless a call is playing, so the listener never heard you.
    """
    listed = subprocess.run(
        [FFMPEG, "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
        capture_output=True,
        text=True,
    )
    audio = (listed.stderr or "").split("AVFoundation audio devices:")[-1]
    devices = re.findall(r"\[(\d+)\] (.+)", audio)
    preferred = []
    for index, name in devices:
        lowered = name.lower()
        if "microphone" in lowered and "iphone" not in lowered and "teams" not in lowered:
            preferred.append((index, name))
    if not preferred:
        for index, name in devices:
            if "macbook" in name.lower() and "teams" not in name.lower():
                preferred.append((index, name))
    if not preferred and devices:
        preferred.append(devices[0])
    if not preferred:
        raise RuntimeError("No microphone was found.")
    index, name = preferred[0]
    return f":{index}", name


def ensure_model() -> None:
    """Download the small English voice model the first time we run."""
    if MODEL.exists() and MODEL.stat().st_size > 1_000_000:
        return
    MODEL.parent.mkdir(parents=True, exist_ok=True)
    say("status", "Downloading the small voice model. This happens once.")
    part = MODEL.with_suffix(".bin.partial")
    try:
        urllib.request.urlretrieve(MODEL_URL, part)
        part.replace(MODEL)
    except Exception as err:
        print(f"Failed while downloading the voice model: {err}", file=sys.stderr)
        say("error", "Could not download the small voice model.")
        raise SystemExit(1) from err
    say("status", "Voice model is ready.")


def record(path: Path, seconds: float, device: str) -> None:
    """Save a short clip from the chosen microphone."""
    try:
        done = subprocess.run(
            [
                FFMPEG,
                "-y",
                "-loglevel",
                "error",
                "-f",
                "avfoundation",
                "-i",
                device,
                "-t",
                str(seconds),
                "-ac",
                "1",
                "-ar",
                "16000",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=seconds + 8,
        )
    except Exception as err:
        print(f"Failed while recording the microphone: {err}", file=sys.stderr)
        raise
    if done.returncode != 0:
        detail = (done.stderr or "").strip() or "ffmpeg failed"
        if "not authorized" in detail.lower() or "permission" in detail.lower():
            raise RuntimeError(
                "The microphone is blocked. Allow Hammerspoon in System Settings, Privacy and Security, Microphone."
            )
        raise RuntimeError(detail)


def transcribe(path: Path) -> str:
    """Turn a clip into text with the small local Whisper model."""
    try:
        done = subprocess.run(
            [
                WHISPER,
                "-m",
                str(MODEL),
                "-f",
                str(path),
                "-l",
                "en",
                "-nt",
                "-np",
                "-bs",
                "1",
                "-bo",
                "1",
                "-nf",
                "-t",
                "4",
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except Exception as err:
        print(f"Failed while transcribing audio: {err}", file=sys.stderr)
        raise
    if done.returncode != 0:
        detail = (done.stderr or done.stdout or "").strip() or "whisper-cli failed"
        raise RuntimeError(detail)
    return clean_text(done.stdout)


def clean_text(raw: str) -> str:
    text = " ".join(raw.split())
    text = re.sub(r"^\[[^\]]+\]\s*", "", text)
    return text.strip()


def normalize(text: str) -> str:
    return re.sub(r"[^a-z ]", "", text.lower()).strip()


def is_silence(text: str) -> bool:
    return normalize(text) in {normalize(line) for line in SILENCE_LINES}


def question_after_wake(text: str) -> str | None:
    """
    Hey at the start is enough. Hey my brain still works.
    'Hey what is on my list' -> 'what is on my list'
    None means Hey was not at the start.
    """
    words = normalize(text).split()
    if not words or words[0] != "hey":
        return None
    if len(words) >= 3 and words[1] == "my" and words[2] == "brain":
        return " ".join(words[3:]).strip()
    return " ".join(words[1:]).strip()


def ask_brain(question: str) -> str:
    """Send the question to the second-brain server and collect the answer."""
    body = json.dumps(
        {"question": question, "model": "gpt-oss:20b", "reasoning": "none", "spoken": True}
    ).encode()
    request = urllib.request.Request(
        BRAIN_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        response = urllib.request.urlopen(request, timeout=90)
    except urllib.error.URLError as err:
        print(f"Failed while calling the second brain: {err}", file=sys.stderr)
        raise RuntimeError(
            "The second brain is not running. In Terminal, run npm run brain."
        ) from err

    answer: list[str] = []
    error: str | None = None
    buffer = ""
    while True:
        chunk = response.read(1024)
        if not chunk:
            break
        buffer += chunk.decode("utf-8", errors="replace")
        parts = buffer.split("\n\n")
        buffer = parts.pop() or ""
        for part in parts:
            for line in part.split("\n"):
                if not line.startswith("data:"):
                    continue
                try:
                    event = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
                if event.get("type") == "delta":
                    answer.append(event.get("text") or "")
                elif event.get("type") == "error":
                    error = event.get("message") or "The second brain failed."
    if error:
        raise RuntimeError(error)
    text = "".join(answer).strip()
    if not text:
        raise RuntimeError("The second brain returned an empty answer.")
    return text


def speak(text: str) -> None:
    """Read the answer with the Mac's built-in voice. This is free."""
    spoken = re.sub(r"\s+", " ", text).strip()
    if not spoken:
        return
    subprocess.run(["say", "-r", "188", spoken], check=False)


def listen() -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    LOG.write_text("", encoding="utf-8")
    ensure_model()
    device, mic_name = microphone()
    say("status", f"Listening on {mic_name}. Say Hey my brain.")
    speak("Listening")
    recent = ""
    with tempfile.TemporaryDirectory(prefix="hey-brain-") as tmp:
        clip = Path(tmp) / "clip.wav"
        while True:
            try:
                record(clip, CHUNK_SECONDS, device)
                heard = transcribe(clip)
            except Exception as err:
                print(f"Failed during the listening loop: {err}", file=sys.stderr)
                say("error", str(err))
                time.sleep(2)
                continue

            if is_silence(heard):
                recent = ""
                continue

            say("heard", heard)
            combined = f"{recent} {heard}".strip()
            question = question_after_wake(combined)
            recent = heard
            if question is None:
                continue

            say("wake", "Hey my brain")
            if not question:
                question = collect_followup(clip, device)
            if not question:
                say("status", "I heard you, but not the question. Try again.")
                speak("I heard you. What should I look up?")
                recent = ""
                continue

            say("question", question)
            try:
                answer = ask_brain(question)
            except Exception as err:
                print(f"Failed while answering: {err}", file=sys.stderr)
                say("error", str(err))
                speak(str(err))
                recent = ""
                continue

            say("answer", answer)
            speak(answer)
            recent = ""
            time.sleep(0.4)


def collect_followup(clip: Path, device: str) -> str:
    """Keep recording until the person stops, or we hit the time limit."""
    pieces: list[str] = []
    for _ in range(FOLLOW_CHUNKS):
        record(clip, CHUNK_SECONDS, device)
        heard = transcribe(clip)
        if is_silence(heard):
            break
        pieces.append(heard)
    return " ".join(pieces).strip()


if __name__ == "__main__":
    try:
        listen()
    except KeyboardInterrupt:
        say("status", "Stopped")
