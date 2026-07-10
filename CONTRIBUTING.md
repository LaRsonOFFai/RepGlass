# Участие в разработке RepGlass

## Подготовка

- Windows 10/11;
- Node.js 24;
- npm 11;
- Git.

```powershell
npm install --prefix app
npm run verify
npm run test:e2e
```

## Правила изменений

- не добавляйте Firebase, Portkey, удалённую телеметрию или plaintext-хранилище ключей;
- renderer не получает Node.js API и работает через минимальный typed preload;
- внешние URL должны проходить allowlist в main process;
- снимки экрана должны удаляться после запроса;
- изменения OAuth сверяйте с официальным Codex App Server;
- изменения STT сверяйте с официальным Realtime transcription API;
- для новой логики добавляйте unit- или Playwright-тесты;
- не ослабляйте `contextIsolation`, renderer sandbox, CSP и `contentProtection`.

Перед pull request выполните:

```powershell
npm run verify
npm run test:e2e
npm run audit:app
```

В PR кратко опишите поведение, риск, проверку и приложите снимок интерфейса для визуальных
изменений.
