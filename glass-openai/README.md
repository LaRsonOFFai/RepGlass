# RepGlass

Clean rebuild of a transparent desktop assistant inspired by Glass:

- translucent always-on-top overlay
- tray controls
- screen-share invisibility through Electron content protection
- OpenAI Codex Auth for answers through the local `codex` CLI
- optional OpenAI Platform API-key authorization for audio transcription
- microphone/system-audio capture
- automatic answer detection while listening

## Run

```powershell
cd D:\Codex\RepGlass\glass-openai
npm install
npm run dev
```

For production preview:

```powershell
npm run build
npm start
```

## OpenAI authorization

RepGlass can use your local Codex login for answers. It checks:

```powershell
codex login status
```

If Codex is not logged in, use `Sign in` inside RepGlass or run:

```powershell
codex login
```

For microphone/system-audio transcription, RepGlass still needs an OpenAI
Platform API key because Codex CLI does not provide a speech-to-text API.

The key is encrypted with Electron `safeStorage` and stored locally.
