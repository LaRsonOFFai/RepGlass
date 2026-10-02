# RepGlass Desktop

Активное приложение RepGlass находится в этой папке. Оно построено на Electron 43, React 19,
TypeScript 6 и Vite 7.

```powershell
npm install
npm run dev
```

Полная локальная проверка:

```powershell
npm run verify
npm run test:e2e
```

Windows installer и portable:

```powershell
npm run dist
```

Результат создаётся в `release`. Полное руководство на русском находится в
[корневом README](../README.md).

На macOS: `npm run dist:mac:arm64` для M-процессоров или `npm run dist:mac:x64`
для Intel. Сборка создаёт DMG и ZIP. [Инструкция для MacBook](../docs/MACOS.md).
**Версия для macOS экспериментальная и требует тестирования на реальном Mac.**
