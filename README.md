# Second Brain

A Mac app that lets you talk to your notes. You speak, it searches your notes on this Mac, asks a model for an answer, and reads the answer out loud.

The window is a small Mac app. Behind it, two programs run on your Mac:

- A Rust program listens on port 3001 and shows the page.
- A Node program listens on port 3002 and does the rest (search, models, voice).

The notes stay where they are. They are not copied into this folder.

This build needs an Apple silicon Mac (M1 or newer) on macOS 13 or newer. The scripts look for programs in `/opt/homebrew/bin`, which is where Homebrew puts them on those Macs.

---

## 1. Apple's compiler tools

The window is compiled on the Mac. Apple's compiler package supplies the linker, the macOS libraries, and the `swift` command that draws the app icon.

In Terminal:

```bash
xcode-select --install
```

Click Install in the window that appears, and wait until it finishes. You do not need the full Xcode app.

## 2. Homebrew programs

If Homebrew is not installed yet, follow the steps at [https://brew.sh](https://brew.sh). Then:

```bash
brew install node rust whisper-cpp ffmpeg python@3.11
```

| Program | What it is for |
|---|---|
| `node` | The Node half of the server. Needs Node 18 or newer. |
| `rust` | Builds the Rust server and the window app. This includes `cargo`. |
| `whisper-cpp` | Turns your speech into text on the Mac (`whisper-cli` and `whisper-server`). |
| `ffmpeg` | Saves meeting recordings. |
| `python@3.11` | Runs Kokoro, the voice that reads answers. |

Check that these files exist:

```bash
ls /opt/homebrew/bin/node /opt/homebrew/bin/whisper-cli /opt/homebrew/bin/whisper-server /opt/homebrew/bin/ffmpeg
```

## 3. Get the code

The current app is on the `rust-port` branch. `main` is the older voice chatbot.

```bash
git clone https://github.com/IyadSultan/nemo.git /Users/USER/code/talk_to_your_brain
cd /Users/USER/code/talk_to_your_brain
git checkout rust-port
npm install
```

`npm install` downloads the JavaScript libraries. It does not build the Mac app yet.

If you put the project in a different folder, or your notes are not in the OneDrive path below, edit these before you continue:

- `voice/start-brain.sh` — `WIKI`, `NODE`, and `ROOT` at the top
- `voice/com.iyad.talk-to-your-brain.plist` — the project path in `ProgramArguments`, `WorkingDirectory`, and the two log paths
- `.env` — `WIKI_PATH` (step 4)

`NODE` should stay `/opt/homebrew/bin/node` on an Apple silicon Mac.

## 4. Keys

```bash
cp .env.example .env
```

Open `.env` and set:

```bash
OPENAI_API_KEY=sk-your-real-key-here
```

Get a key at [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys). The default answers come from Claude (step 7), but OpenAI is still used for live voice and some tools.

If you use the Gemini live voice, add this line too:

```bash
GEMINI_API_KEY=your-gemini-key
```

The notes folder. Uncomment the line and set it if your notes are somewhere else:

```bash
WIKI_PATH=/Users/USER/Library/CloudStorage/OneDrive-KingHusseinCancerCenter/2nd_brain/wiki
```

`.env` is not in git. Copy it by hand from the old Mac. Do not commit it.

Sign in to OneDrive on the new Mac and wait until that notes folder is on disk. The start script waits up to two minutes for it after login.

## 5. The home folder the app reads

Every answer can use four files in `~/.brain/`. Copy that folder from the old Mac if you have it. If you are starting fresh:

```bash
mkdir -p ~/.brain
cp manual.md ~/.brain/manual.md
touch ~/.brain/brain.md ~/.brain/memories.md ~/.brain/code.md
```

| File | What it holds |
|---|---|
| `brain.md` | What the app has learned, summarized each night |
| `memories.md` | Short memories you told it to keep |
| `manual.md` | What the app can do. Used when you ask "what can you do?" |
| `code.md` | Rules pasted into every answer (the first 8,000 characters) |

## 6. Hearing and speaking on the Mac

Whisper models are not in git. Download them once (about 1 GB):

```bash
mkdir -p voice/models
curl -L --fail -o voice/models/ggml-small.en.bin \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"
curl -L --fail -o voice/models/ggml-large-v3-turbo-q5_0.bin \
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin"
```

The first file is the fast English listener. The second hears English and Arabic. Copy `voice/models/` from the old Mac if you would rather not download them again.

Kokoro speaks the answers. The server starts Python from the fixed path `/usr/local/bin/python3.11`, so link Homebrew's Python there:

```bash
sudo mkdir -p /usr/local/bin
sudo ln -sf "$(brew --prefix python@3.11)/bin/python3.11" /usr/local/bin/python3.11
/usr/local/bin/python3.11 -m pip install numpy soundfile kokoro
```

The first time you pick a voice, Kokoro downloads a small voice file from Hugging Face and keeps it. If Kokoro cannot start, the app falls back to the Mac's own voice.

## 7. Claude and Ollama

The default model is Claude Opus, through the Claude Code program you already sign in to. No Claude API key is stored here. Install Claude Code, then run `claude` once and sign in. The app looks for the program at `~/.local/bin/claude`.

Ollama runs two local models: one compresses old chat, and one does meaning search.

```bash
brew install ollama
brew services start ollama
ollama pull gpt-oss:20b
ollama pull embeddinggemma
```

`gpt-oss:20b` is a large download. Answers still work without Ollama. Memory compression and meaning search wait until those two models are installed.

## 8. Build

From the project folder:

```bash
cargo build --release --manifest-path rust/Cargo.toml --bin brain
rust/window/bundle.sh
```

The first `cargo` build downloads libraries and can take several minutes. It writes the server to `rust/target/release/brain`.

`rust/window/bundle.sh` builds the window and installs it as `/Applications/Second Brain.app`. On a new Mac there is no signing certificate yet, so the script signs the app loosely and prints a line about that. macOS will ask again for the microphone, camera, and screen recording. That is expected. To keep those permissions across later rebuilds, the certificate and its password would need to be copied into `~/Library/Keychains/second-brain-signing.keychain-db` and `~/.brain/signing/pass`.

If macOS says the app cannot be opened because it is from an unidentified developer: right-click **Second Brain** in Applications, choose **Open**, then **Open** again.

## 9. Start it at login

```bash
mkdir -p ~/Library/Logs/talk-to-your-brain
cp voice/com.iyad.talk-to-your-brain.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.iyad.talk-to-your-brain.plist
```

That runs `voice/start-brain.sh` whenever you log in, and restarts it if it stops. Logs:

- `~/Library/Logs/talk-to-your-brain/brain.log`
- `~/Library/Logs/talk-to-your-brain/brain.err.log`

Open **Second Brain** from Applications. The first launch asks for the microphone. Allow it. Camera is used for meeting photos. Screen Recording is used for the Snapshot button (System Settings → Privacy & Security → Screen Recording).

Check that the server is up:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3001/voice.html
```

`200` means the page is being served.

In the app, open Settings and add your notes folder if it is not already listed.

## After you change the code

| What changed | What to do |
|---|---|
| The page only (`second-brain/public/`) | In the app, press Command-R |
| The Node or Rust server | `launchctl kickstart -k gui/$(id -u)/com.iyad.talk-to-your-brain` |
| The window app (`rust/window/`) | Run `rust/window/bundle.sh`, quit the app, and open it again |

To build the Rust server again after editing it:

```bash
cargo build --release --manifest-path rust/Cargo.toml --bin brain
launchctl kickstart -k gui/$(id -u)/com.iyad.talk-to-your-brain
```

A file named `.node-only` in the project folder makes the start script skip Rust and run only Node on port 3001. Delete that file to use both programs again.

## Extra pieces

These are not required to talk to your notes.

| Feature | Install |
|---|---|
| Slides | `brew install rustup trunk`, then `voice/install-deckcraft-web.sh` |
| Word editing | `brew install rustup trunk`, then `voice/install-wordcraft.sh` |
| PDF tools | `brew install poppler ghostscript tesseract`, then `voice/install-pdfcraft.sh`. Printing a PDF also uses Google Chrome. |
| R tab | Install R so that `/usr/local/bin/Rscript` exists, then open the R button in the app. |
| Short videos the app makes | `npm i -g hyperframes` |
| Menu bar and keyboard shortcuts | Install [Hammerspoon](https://www.hammerspoon.org/), point it at `voice/hammerspoon.lua`, and choose Reload Config. |

## If something fails

| What you see | What to check |
|---|---|
| "The second brain is not running" | `launchctl kickstart -k gui/$(id -u)/com.iyad.talk-to-your-brain`, then read `brain.err.log` |
| App opens, then the page is old | Quit the app after `bundle.sh`. Command-R reloads the page, not the window program. |
| It cannot hear you | `whisper-cli` and `whisper-server` are on `/opt/homebrew/bin`, and both files in `voice/models/` downloaded fully |
| It answers but will not speak in the Kokoro voice | `/usr/local/bin/python3.11 voice/kokoro_server.py` should stay running and print no error. The Mac voice is the fallback. |
| "Missing OPENAI_API_KEY" | `.env` is in the project folder, then restart with the `launchctl` command above |
| Notes are not found | OneDrive has finished downloading, `WIKI_PATH` in `.env` matches the folder, and that folder is added in Settings |
| Microphone or camera asks every rebuild | The local signing certificate is not on this Mac. See step 8. |
