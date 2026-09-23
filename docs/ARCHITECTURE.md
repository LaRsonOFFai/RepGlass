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
  передаёт PCM 24 kHz и обрабатывает partial/final events `GPT-Live-Transcribe`.
- `openaiService.ts` получает доступные ответные модели через `/v1/models`, использует
  Responses API для текста и экрана, а записи расшифровывает через `GPT-Transcribe`.
- `assistantRuntime.ts` управляет состояниями сессии, очередью автоответов, smart Ask,
  Live Insights, финальным Summary и привязанным screen context.
- `transcriptDedup.ts` удаляет совпадающее системное эхо из микрофонной транскрипции.
- `screenCaptureService.ts` получает текущий display, создаёт временный PNG и удаляет его после
  запроса.
- `secureStore.ts` хранит только настройки и DPAPI-encrypted Platform API key.

## Renderer

Renderer не имеет Node integration. Системный loopback и микрофон не смешиваются: каждый
источник проходит через отдельный AudioWorklet и локальный VAD, преобразуется в mono PCM16
24 kHz и отправляется в собственную transcription-сессию. Pre-roll сохраняет первые слова.

Интерфейс состоит из одного overlay с компактной командной панелью, Listen и Ask. Listen
переключает транскрипцию, Live Insights и Summary; Ask показывает один активный запрос вместе с
его источниками и снимком. Дополнительные технические окна не создаются.

## Потоки данных

1. AudioCapture маркирует PCM chunks как `microphone` или `system` и отправляет их через IPC.
2. Две Realtime STT-сессии возвращают события «Вы» и «Собеседник».
3. Runtime добавляет реплики и ответы в контекст текущего запуска и проверяет вопросы собеседника.
4. Для smart-screen окно и tray скрываются, затем desktopCapturer делает снимок.
5. Codex App Server или Responses API получает полный контекст и стримит ответ в карточку.
6. Пауза останавливает STT без очистки контекста; завершение сессии создаёт финальный Summary.
7. Временный снимок удаляется в `finally`, даже если запрос завершился ошибкой.
