# Архитектура RepGlass

RepGlass использует один Electron `BrowserWindow` и три изолированных слоя.

```text
React renderer
  | typed IPC через contextBridge
Electron preload (sandboxed CJS)
  | allowlisted handlers/events
Electron main
  |-- Codex App Server (bundled codex.exe, stdio JSON-RPC)
  |-- OpenAI Realtime STT (отдельные WebSocket для Me/Them)
  |-- OpenAI Responses API (опциональный provider)
  |-- desktopCapturer + contentProtection
  `-- safeStorage + local settings
```

## Main process

- `codexService.ts` запускает официальный bundled `codex.exe app-server --stdio` скрытым
  дочерним процессом, выполняет OAuth, получает список моделей и обрабатывает поток turns.
- `realtimeTranscriptionService.ts` открывает Realtime WebSocket с `intent=transcription`,
  передаёт PCM 24 kHz и обрабатывает partial/final events `GPT-Realtime-Whisper`.
- `assistantRuntime.ts` связывает две транскрипции, полный контекст запуска, детектор вопросов,
  очередь автоответов, smart Ask, summary, персонализацию и screen context.
- `screenCaptureService.ts` получает текущий display, создаёт временный PNG и удаляет его после
  запроса.
- `secureStore.ts` хранит только настройки и DPAPI-encrypted Platform API key.

## Renderer

Renderer не имеет Node integration. Системный loopback и микрофон не смешиваются: каждый
источник проходит через отдельный AudioWorklet и локальный VAD, преобразуется в mono PCM16
24 kHz и отправляется в собственную transcription-сессию. Pre-roll сохраняет первые слова.

Интерфейс состоит из одного overlay: команды, лента карточек, live-транскрипция, подключение,
персонализация, аудио и приватность. Дополнительные технические окна не создаются.

## Потоки данных

1. AudioCapture маркирует PCM chunks как `microphone` или `system` и отправляет их через IPC.
2. Две Realtime STT-сессии возвращают события «Вы» и «Собеседник».
3. Runtime добавляет реплики и ответы в контекст текущего запуска и проверяет вопросы собеседника.
4. Для smart-screen окно и tray скрываются, затем desktopCapturer делает снимок.
5. Codex App Server или Responses API получает полный контекст и стримит ответ в карточку.
6. При остановке listening тот же контекст используется для вкладки «Итоги».
7. Временный снимок удаляется в `finally`, даже если запрос завершился ошибкой.
