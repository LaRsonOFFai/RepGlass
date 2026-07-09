# OpenAI and Codex authentication

RepGlass can use OpenAI models through the OpenAI Platform API. For direct API
access, use an OpenAI API key from the UI or from an environment variable:

```powershell
$env:OPENAI_API_KEY="sk-..."
npm start
```

The app also accepts `PICKLE_OPENAI_API_KEY` for compatibility with the upstream
codebase. If either variable is present and no OpenAI key is already saved,
RepGlass selects OpenAI for both LLM and STT on startup.

## Why not read Codex login?

Codex sign-in is for Codex itself: the Codex app, CLI, IDE extension, SDK, and
cloud workflows. It is not a general OAuth provider for third-party desktop
apps. RepGlass can call the local Codex CLI for answers when the user is logged
in, but normal OpenAI API calls should still use OpenAI Platform API keys.

Do not import `~/.codex/auth.json`, OS keychain Codex credentials, or
`CODEX_ACCESS_TOKEN` into this app. Those credentials are sensitive and are not
the right auth surface for normal API requests.

If you want users to connect through a paid RepGlass subscription instead of
entering their own API key, use the managed gateway pattern in
[OpenAI subscription gateway](./OPENAI_SUBSCRIPTION_GATEWAY.md).

## Auto-answer controls

Auto-answering is enabled by default while a Listen session is active. It opens
the existing Ask response window when a likely question or explicit request is
detected in the final transcript.

Optional environment variables:

```powershell
$env:PICKLE_AUTO_ANSWER_ENABLED="false"
$env:PICKLE_AUTO_ANSWER_DEBOUNCE_MS="1800"
$env:PICKLE_AUTO_ANSWER_COOLDOWN_MS="12000"
$env:PICKLE_AUTO_ANSWER_BUSY_RETRY_MS="2500"
```

Keep the cooldown above a few seconds to avoid noisy meetings causing multiple
overlapping answers.
