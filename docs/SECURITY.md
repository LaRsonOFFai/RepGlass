# Безопасность RepGlass

## Реализованные меры

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`;
- preload собирается в sandbox-compatible CJS и раскрывает только typed IPC API;
- строгая Content Security Policy без удалённых scripts и frames;
- запрет `window.open` и renderer navigation;
- allowlist для внешних HTTPS URL;
- один экземпляр приложения;
- Windows DPAPI вместо plaintext/base64 для Platform API key;
- Codex OAuth и refresh token принадлежат официальному Codex App Server;
- bundled Codex запускается напрямую, без shell и PowerShell;
- ephemeral Codex threads, read-only sandbox, network disabled для tools;
- prompt-injection boundary для текста транскрипции и изображения;
- screen captures удаляются в `finally`;
- `contentProtection` включён по умолчанию и проверяется Playwright;
- tray скрывается во время прослушивания и собственного screen capture;
- production dependency audit выполняется локально и в CI;
- Electron installer собирается с ASAR, а native Codex распаковывается только в необходимой
  директории.
- production renderer загружается через защищённый `repglass://app` protocol с проверкой пути
  и MIME allowlist; дополнительные привилегии `file://` отключены Electron fuse.

## Ограничения

Публичная сборка 1.2.0 не подписана Authenticode-сертификатом. Windows SmartScreen может
показывать предупреждение до появления репутации файла. Для каждого EXE в GitHub Release
публикуется SHA-256; загружать сборки следует только из `LaRsonOFFai/RepGlass`.

`contentProtection` — системная защита обычного desktop capture, а не DRM-гарантия. Она не
защищает от камеры, capture-card, привилегированного драйвера, удалённого рабочего стола или
уязвимости ОС. RepGlass также не может универсально определить начало screen-share во всех
сторонних приложениях; поэтому tray гарантированно скрывается во время активного listening,
когда такой сценарий наиболее вероятен.

## Сообщение об уязвимости

Не публикуйте API keys, OAuth tokens, аудиозаписи или screenshots в issue. Создайте приватное
security advisory в GitHub и приложите минимальные шаги воспроизведения без секретов.
