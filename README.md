# RepGlass

RepGlass is a translucent desktop AI assistant inspired by Glass, rebuilt for a
modern Windows/Electron workflow. It listens to live audio, keeps a compact
overlay on screen, answers detected questions, and stays protected from normal
screen sharing through Electron content protection.

The project is based on `pickle-com/glass`, but the app name, startup behavior,
provider setup, tray controls, and OpenAI Codex integration were adapted for
RepGlass.

## What It Does

- Shows a small translucent always-on-top answer overlay.
- Starts cleanly without opening a stack of DevTools/browser windows.
- Lives in the Windows tray with quick controls for Listen, Ask, Settings, and
  show/hide.
- Keeps Electron windows excluded from normal screen capture where the OS and
  meeting app support protected content.
- Supports OpenAI, OpenAI Codex Auth, Gemini, Anthropic, Deepgram, Ollama, and
  local Whisper.
- Can detect questions in the live transcript and open an answer automatically.
- Can still answer manually with `Ctrl + Enter`.
- Stores provider keys locally through the existing app settings flow.

## Important Auth Notes

OpenAI Codex login is supported for answers through the local Codex CLI. The app
checks:

```powershell
codex --version
codex login status
```

If Codex is installed and logged in, choose `OpenAI Codex Auth` as the LLM
provider in RepGlass.

Codex login is not a speech-to-text API. For listening/transcription, choose one
of the STT providers:

- `Whisper (Local)` for local speech recognition.
- `OpenAI` with an OpenAI Platform API key.
- `Gemini` with a Google AI Studio API key.
- `Deepgram` with a Deepgram API key.

ChatGPT Plus/Pro and Codex login are not direct billing credentials for arbitrary
third-party API calls. For a paid app subscription model, use a backend gateway;
see [OpenAI subscription gateway](./docs/OPENAI_SUBSCRIPTION_GATEWAY.md).

## Requirements

Recommended for Windows:

- Windows 10/11 x64.
- Git.
- Node.js `24.x`.
- npm `11.x`.
- Python 3.11 or newer.
- Visual Studio Build Tools 2022 with the `Desktop development with C++`
  workload. This is needed by native Electron dependencies such as SQLite/keytar.
- Optional: OpenAI Codex CLI for `OpenAI Codex Auth`.

Check your versions:

```powershell
node --version
npm --version
python --version
git --version
```

This repository includes `.nvmrc` and `.node-version` pinned to the tested Node
major version.

## Install On A PC

Clone the repository:

```powershell
git clone https://github.com/LaRsonOFFai/RepGlass.git
cd RepGlass
```

Install desktop dependencies:

```powershell
npm install
```

Install and build the web/login part:

```powershell
cd pickleglass_web
npm install
npm run build
cd ..
```

Start the desktop app:

```powershell
npm start
```

The app should open the translucent overlay and create a tray icon. Use the tray
menu if the overlay is hidden behind other windows.

## One-Command Setup

For a fresh local setup you can also run:

```powershell
npm run setup
```

This installs root dependencies, installs/builds `pickleglass_web`, and starts
RepGlass.

## Start With Hidden PowerShell

For normal daily use on Windows:

```powershell
npm run start:hidden
```

This launches RepGlass through `Start-RepGlass-hidden.vbs` and writes logs to:

```text
%LOCALAPPDATA%\RepGlass\repglass-hidden.log
```

There is also a direct helper script:

```powershell
.\scripts\start-hidden.ps1
```

## Configure AI Providers

Open Settings in the app and select providers for LLM and STT.

OpenAI API key:

```powershell
$env:OPENAI_API_KEY="sk-..."
npm start
```

Gemini API key:

```powershell
$env:GEMINI_API_KEY="your-google-ai-studio-key"
npm start
```

Local Whisper does not require a cloud API key. It downloads/uses local model
files and is slower on weak CPUs. `whisper-small` is usually a better real-time
choice than `whisper-medium`.

OpenAI Codex Auth:

```powershell
codex login
codex login status
npm start
```

Then choose `OpenAI Codex Auth` for the LLM provider. Keep STT on Whisper,
OpenAI, Gemini, or Deepgram.

## Live Listening And Auto Answers

1. Start RepGlass.
2. Open Settings and choose an STT provider.
3. Press `Listen`.
4. Speak normally or play meeting audio.
5. Open `Show Transcription` to inspect recognized text.
6. Ask a question aloud. RepGlass should detect likely questions and prepare an
   answer automatically.

Manual answer shortcut:

```text
Ctrl + Enter
```

Auto-answer environment controls:

```powershell
$env:PICKLE_AUTO_ANSWER_ENABLED="false"
$env:PICKLE_AUTO_ANSWER_DEBOUNCE_MS="1800"
$env:PICKLE_AUTO_ANSWER_COOLDOWN_MS="12000"
$env:PICKLE_AUTO_ANSWER_BUSY_RETRY_MS="2500"
```

## Keyboard Shortcuts

```text
Ctrl + \      Show/hide the main overlay
Ctrl + Enter  Ask AI using recent screen/audio context
Ctrl + Arrow  Move the overlay
```

## Build Installer

Install dependencies first, then build:

```powershell
npm run build:win
```

The packaged Windows output is created under:

```text
dist\
```

For an unpacked local package:

```powershell
npm run package
```

## Deploy From Source

To deploy this project to a new PC:

1. Install the requirements listed above.
2. Clone `https://github.com/LaRsonOFFai/RepGlass.git`.
3. Run `npm install`.
4. Run `cd pickleglass_web && npm install && npm run build && cd ..`.
5. Run `npm start` for development, or `npm run build:win` to create an
   installer.
6. Configure providers inside Settings.
7. For Codex answers, install/login to Codex CLI and choose `OpenAI Codex Auth`
   as the LLM provider.

## Repository Layout

```text
src/                 Main Electron app, services, windows, providers, UI
src/features/listen  Listening, STT, transcript, auto-answer logic
src/features/ask     Ask/answer orchestration
src/features/common  AI providers, auth, model state, shared services
src/window           Overlay and tray window management
pickleglass_web/     Web/login companion app
docs/                Auth and subscription-gateway notes
scripts/             Windows helper launch scripts
glass-openai/        Experimental clean Electron/Vite rebuild prototype
```

## Screen-Share Invisibility

RepGlass enables Electron content protection for its windows. This is the same
class of protection used by many desktop apps to keep windows out of normal
screen capture.

Always test it in the exact meeting or recording app you plan to use. Some apps,
drivers, capture cards, remote desktops, or admin policies can bypass normal OS
capture protection.

## Development

Build only the Electron renderer:

```powershell
npm run build:renderer
```

Build all local frontend assets:

```powershell
npm run build:all
```

Run formatter manually if needed:

```powershell
npx prettier --write .
```

## Troubleshooting

If the overlay is not visible:

- Check the tray icon and choose show/open.
- Stop any old `electron.exe` processes and run `npm start` again.
- Check `%LOCALAPPDATA%\RepGlass\repglass-hidden.log` if started hidden.

If transcription is empty:

- Confirm that Windows microphone permissions are enabled.
- Try `Whisper (Local)` with `whisper-small`.
- Check that the selected STT provider has a valid key if it is cloud-based.
- Speak for at least a few seconds so the audio chunk is long enough.

If Codex Auth is unavailable:

- Run `codex --version`.
- Run `codex login`.
- Run `codex login status`.
- Restart RepGlass and select `OpenAI Codex Auth` as LLM provider.

## License

GPL-3.0. This project keeps the upstream license from the original Glass codebase.
