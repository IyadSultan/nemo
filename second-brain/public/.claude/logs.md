# Session log — public

Append-only. Written by `session_logger.py`; digit runs are redacted.
**Response:** Checking that the Kokoro voice (used by local models) doesn't have the same problem:

## 2026-10-09 21:27 — public

**Prompt:** is the voice model local?
**Response:** Fixed, but not yet tested by voice. After you said "stop", every later answer was written but played into a paused audio player, so you heard nothing. - **Cause:** "Stop" pauses the player that the Claude/GPT voice plays through. Nothing pressed play again, because play only ran once, when the voice line first connected at the start of the call. The same bug was in the Stop button since 2 October. […]

## 2026-10-09 21:27 — public

**Prompt:** i mean chrome listening model?
**Response:** No, not with your current setup. With Claude Opus, the speaking voice is OpenAI's cloud model, and since today the listening is Google's cloud too. Each model splits it like this: | Model | Listening | Answer | Speaking | |---|---|---|---| | **Claude Opus / Sonnet** (default) | Google, cloud (new default); Whisper on your Mac if you switch it | Claude, cloud (your subscription) | OpenAI Voice mini […]

## 2026-10-09 21:29 — public

**Prompt:** try on device model
**Response:** Before changing anything: if the status line says "Chrome on this Mac" or "Google cloud", the page is listening in English only, and Arabic can't work in that mode. Only the "English + Arabic (auto)" option hears Arabic. There's also a real weakness in the auto mode when you say an English "Hey" followed by Arabic: Whisper may pick the wrong language for the clip, or write "Hey" in a form I don't […]

## 2026-10-09 22:28 — public

**Prompt:** arabic works but LLM is not responding to ARabic
**Response:** It's fixed: I restarted the brain server, and `/meeting/save` now answers with JSON instead of the "not found" page. **Next:** click **Save minutes** again on the same meeting. The page still has the meeting, so you don't need to record it again. If the call ended when the server restarted, press **Start talking** again before your next meeting. I logged this mistake as `~/.claude/errors/error_101 […]

## 2026-10-14 19:07 — public

**Prompt:** both
**Response:** Both handlers are synchronous and correct. I'm checking whether the page's main thread is blocked while it's listening, which would make clicks seem lost.
