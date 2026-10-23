"""
Makes a music bed for the movie editor from a few words of mood.

    python3 -I music.py --output track.wav --seconds 40 --prompt "warm acoustic guitar, travel film" [--engine auto|online|local]

online  Google Lyria RealTime through the Gemini key (GEMINI_API_KEY). Needs the network.
local   MusicGen small on this Mac (facebook/musicgen-small, already in the Hugging Face cache).
auto    online when a key is set and it answers; otherwise local.

Lyria streams for the whole length asked for, so the music keeps changing. MusicGen makes
one clip of up to 28 seconds, which is then looped with crossfades to the length asked for.
Prints one JSON line: {"ok": true, "engine": "local", "seconds": 40.0} or {"ok": false, "error": "..."}.
"""

import argparse
import asyncio
import json
import os
import sys

import numpy as np

RATE = 32000
# MusicGen's decoder stops near 30 seconds.
SEED_SECONDS = 28.0
# Lyria plays in real time, so very long movies would take as long to score.
ONLINE_MAX_SECONDS = 420.0


def say(payload):
    print(json.dumps(payload), flush=True)


def loop_to(audio, rate, seconds, fade=1.5):
    """Repeats a clip with crossfades until it is `seconds` long, then fades the end."""
    if audio.ndim == 1:
        audio = audio[:, None]
    want = int(seconds * rate)
    cross = int(min(fade, max(0.1, len(audio) / rate / 4)) * rate)
    out = audio.copy()
    while len(out) < want:
        ramp = np.linspace(0.0, 1.0, cross)[:, None]
        tail = out[-cross:] * (1.0 - ramp)
        head = audio[:cross] * ramp
        out = np.concatenate([out[:-cross], tail + head, audio[cross:]])
    out = out[:want]
    tail = min(int(2.0 * rate), len(out))
    out[-tail:] *= np.linspace(1.0, 0.0, tail)[:, None]
    peak = float(np.max(np.abs(out))) or 1.0
    return out * (0.8 / peak)


def local(prompt, seconds):
    import torch
    from transformers import AutoProcessor, MusicgenForConditionalGeneration

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    processor = AutoProcessor.from_pretrained("facebook/musicgen-small")
    model = MusicgenForConditionalGeneration.from_pretrained("facebook/musicgen-small").to(device)
    rate = model.config.audio_encoder.sampling_rate
    seed = min(SEED_SECONDS, max(8.0, seconds))
    # MusicGen writes about 50 tokens a second. Its decoder stops near 30 seconds.
    tokens = int(seed * 50)
    inputs = processor(text=[prompt], padding=True, return_tensors="pt").to(device)
    with torch.no_grad():
        audio = model.generate(**inputs, do_sample=True, guidance_scale=3.0, max_new_tokens=tokens)
    clip = audio[0, 0].float().cpu().numpy()
    return clip, rate


async def online_async(prompt, seconds):
    # python.org's Python ships without the system certificates. certifi has them.
    try:
        import certifi

        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    except ImportError:
        pass
    from google import genai
    from google.genai import types

    key = os.environ.get("GEMINI_API_KEY", "")
    if not key:
        raise RuntimeError("no GEMINI_API_KEY")
    client = genai.Client(api_key=key, http_options={"api_version": "v1alpha"})
    seed = min(ONLINE_MAX_SECONDS, max(8.0, seconds)) + 1.0
    chunks = []
    got = 0
    rate = 48000
    want = int(seed * rate) * 2 * 2  # stereo, 16-bit
    async with client.aio.live.music.connect(model="models/lyria-realtime-exp") as session:
        await session.set_weighted_prompts(prompts=[types.WeightedPrompt(text=prompt, weight=1.0)])
        await session.set_music_generation_config(config=types.LiveMusicGenerationConfig(temperature=1.0))
        await session.play()
        async for message in session.receive():
            content = getattr(message, "server_content", None)
            for chunk in getattr(content, "audio_chunks", None) or []:
                data = chunk.data
                if not data:
                    continue
                chunks.append(data)
                got += len(data)
            if got >= want:
                break
        await session.stop()
    raw = b"".join(chunks)
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    pcm = pcm[: (len(pcm) // 2) * 2].reshape(-1, 2)
    # The first second is the model warming up.
    return pcm[rate:], rate


def online(prompt, seconds):
    return asyncio.run(asyncio.wait_for(online_async(prompt, seconds), timeout=min(ONLINE_MAX_SECONDS, seconds) + 90))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--seconds", type=float, default=60.0)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--engine", default="auto", choices=["auto", "online", "local"])
    args = parser.parse_args()

    import soundfile as sf

    seconds = min(600.0, max(8.0, args.seconds))
    engines = {"auto": ["online", "local"], "online": ["online"], "local": ["local"]}[args.engine]
    errors = []
    for engine in engines:
        try:
            clip, rate = online(args.prompt, seconds) if engine == "online" else local(args.prompt, seconds)
            if len(clip) < rate * 2:
                raise RuntimeError("the clip came back empty")
            sf.write(args.output, loop_to(clip, rate, seconds), rate, subtype="PCM_16")
            say({"ok": True, "engine": engine, "seconds": seconds})
            return 0
        except Exception as err:  # noqa: BLE001 - the next engine is the fallback
            errors.append(f"{engine}: {type(err).__name__}: {str(err)[:160]}")
            print(f"music {engine} failed: {err}", file=sys.stderr)
    say({"ok": False, "error": "; ".join(errors) or "No music engine could run."})
    return 1


if __name__ == "__main__":
    sys.exit(main())
