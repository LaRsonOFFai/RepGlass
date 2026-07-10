# Архитектура RepGlass

RepGlass использует один Electron `BrowserWindow` и три изолированных слоя.

```text
React renderer
  | typed IPC через contextBridge
Electron preload (sandboxed CJS)
  | allowlisted handlers/events
Electron main
  |-- Codex App Server (bundled codex.exe, stdio JSON-RPC)
  |-- OpenAI Realtime STT (WebSocket)
  |-- OpenAI Responses API (опциональный provider)
  |-- desktopCapturer + contentProtection
  `-- safeStorage + local settings
```

## Main process

- `codexService.ts` запускает официальный bundled `codex.exe app-server --stdio` скрытым
  дочерним процессом, выполняет OAuth, получает список моделей и обрабатывает поток turns.
- `realtimeTranscriptionService.ts` открывает Realtime WebSocket с `intent=transcription`,
  передаёт PCM 24 kHz и обрабатывает partial/final events `GPT-Realtime-Whisper`.
- `assistantRuntime.ts` связывает транскрипцию, детектор вопросов, очередь автоответов,
  персонализацию и screen context.
- `screenCaptureService.ts` получает текущий display, создаёт временный PNG и удаляет его после
  запроса.
- `secureStore.ts` хранит только настройки и DPAPI-encrypted Platform API key.

## Renderer

Renderer не имеет Node integration. По умолчанию системный loopback и микрофон смешиваются
через Web Audio gain-узлы. AudioWorklet преобразует результат в mono PCM16 24 kHz, а локальный
VAD режет речь на фразы и добавляет pre-roll, чтобы не терять первые слова.

Интерфейс состоит из одного overlay: команды, лента карточек, live-транскрипция, подключение,
персонализация, аудио и приватность. Дополнительные технические окна не создаются.

## Потоки данных

1. AudioCapture отправляет PCM chunks через IPC main process.
2. Realtime STT возвращает delta и completed transcript events.
3. Runtime обновляет UI и проверяет завершённую фразу детектором вопросов.
4. Для smart-screen вопрос классифицируется локально, затем desktopCapturer делает снимок.
5. Codex App Server или Responses API стримит ответ в одну карточку.
6. Временный снимок удаляется в `finally`, даже если запрос завершился ошибкой.
