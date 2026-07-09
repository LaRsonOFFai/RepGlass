# RepGlass

RepGlass - это полупрозрачный настольный AI-ассистент для Windows, вдохновленный
проектом Glass. Приложение слушает аудио в реальном времени, показывает ответы в
аккуратном overlay-окне, умеет автоматически замечать вопросы в расшифровке и
может использовать OpenAI Codex Auth для ответов через локальный Codex CLI.

Проект основан на `pickle-com/glass`, но адаптирован под RepGlass: изменено
название, обновлены зависимости, добавлен запуск без лишних технических окон,
добавлен tray-режим, OpenAI Codex Auth, автоответы во время прослушивания и
подробная инструкция для установки на ПК.

## Возможности

- Полупрозрачное окно поверх остальных приложений для вывода ответов.
- Запуск без кучи DevTools и технических браузерных окон.
- Иконка в системном трее Windows с быстрыми действиями: показать/скрыть окно,
  запустить Listen, открыть Ask и Settings.
- Защита окон Electron от обычной записи экрана и демонстрации экрана через
  `contentProtection`, где это поддерживается Windows и приложением для звонков.
- Поддержка OpenAI, OpenAI Codex Auth, Gemini, Anthropic, Deepgram, Ollama и
  локального Whisper.
- Автоматическое обнаружение вопросов в live-транскрипции и запуск ответа без
  постоянного нажатия `Ctrl + Enter`.
- Ручной запрос ответа по горячей клавише `Ctrl + Enter`.
- Локальное хранение ключей провайдеров через настройки приложения.

## Важное про OpenAI Codex Auth

OpenAI Codex Auth поддерживается для ответов через локальный Codex CLI.
Приложение проверяет:

```powershell
codex --version
codex login status
```

Если Codex установлен и пользователь авторизован, в RepGlass можно выбрать
`OpenAI Codex Auth` как LLM-провайдер.

Важно: Codex login не является API для распознавания речи. Для прослушивания и
транскрипции нужно выбрать отдельный STT-провайдер:

- `Whisper (Local)` - локальное распознавание речи без облачного API-ключа.
- `OpenAI` - через OpenAI Platform API key.
- `Gemini` - через Google AI Studio API key.
- `Deepgram` - через Deepgram API key.

Подписка ChatGPT Plus/Pro и вход в Codex не являются прямыми платежными данными
для любых сторонних API-вызовов. Для подписки внутри собственного приложения
нужен backend gateway. Подробнее: [OpenAI subscription gateway](./docs/OPENAI_SUBSCRIPTION_GATEWAY.md).

## Требования

Рекомендуемая среда для Windows:

- Windows 10/11 x64.
- Git.
- Node.js `24.x`.
- npm `11.x`.
- Python 3.11 или новее.
- Visual Studio Build Tools 2022 с компонентом `Desktop development with C++`.
  Это нужно для нативных Electron-зависимостей, например SQLite/keytar.
- Опционально: OpenAI Codex CLI, если нужен режим `OpenAI Codex Auth`.

Проверка версий:

```powershell
node --version
npm --version
python --version
git --version
```

В репозитории есть `.nvmrc` и `.node-version` с зафиксированной основной версией
Node.js.

## Установка на ПК

Склонируйте репозиторий:

```powershell
git clone https://github.com/LaRsonOFFai/RepGlass.git
cd RepGlass
```

Установите зависимости основного Electron-приложения:

```powershell
npm install
```

Установите зависимости и соберите web/login-часть:

```powershell
cd pickleglass_web
npm install
npm run build
cd ..
```

Запустите приложение:

```powershell
npm start
```

После запуска должно появиться полупрозрачное окно RepGlass и иконка в трее.
Если окно скрыто, откройте его через меню иконки в трее.

## Быстрая установка одной командой

Для свежей локальной установки можно выполнить:

```powershell
npm run setup
```

Для Windows можно использовать команду, которая установит зависимости,
соберет проект, создаст ярлык скрытого запуска на рабочем столе и сразу
запустит RepGlass скрыто:

```powershell
npm run setup:win
```

Команда установит зависимости в корне проекта, установит и соберет
`pickleglass_web`, а затем запустит RepGlass.

## Запуск со скрытым PowerShell

Для обычного ежедневного запуска на Windows:

```powershell
npm run start:hidden
```

Приложение будет запущено через `Start-RepGlass-hidden.vbs`, а логи будут
записываться сюда:

```text
%LOCALAPPDATA%\RepGlass\repglass-hidden.log
```

Также можно запустить helper-скрипт напрямую:

```powershell
.\scripts\start-hidden.ps1
```

## Настройка AI-провайдеров

Откройте Settings в приложении и выберите провайдеры для LLM и STT.

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

Локальный Whisper не требует облачного API-ключа. Он использует локальные модели
и может работать медленнее на слабых CPU. Для real-time режима обычно лучше
использовать `whisper-small`, а не `whisper-medium`.

OpenAI Codex Auth:

```powershell
codex login
codex login status
npm start
```

После этого выберите `OpenAI Codex Auth` как LLM-провайдер. Для STT оставьте
Whisper, OpenAI, Gemini или Deepgram.

## Прослушивание и автоответы

1. Запустите RepGlass.
2. Откройте Settings и выберите STT-провайдер.
3. Нажмите `Listen`.
4. Говорите в микрофон или включите аудио встречи.
5. Откройте `Show Transcription`, чтобы проверить распознанный текст.
6. Задайте вопрос вслух. RepGlass должен определить вопрос и подготовить ответ
   автоматически.

Ручной запуск ответа:

```text
Ctrl + Enter
```

Настройки автоответов через переменные окружения:

```powershell
$env:PICKLE_AUTO_ANSWER_ENABLED="false"
$env:PICKLE_AUTO_ANSWER_DEBOUNCE_MS="1800"
$env:PICKLE_AUTO_ANSWER_COOLDOWN_MS="12000"
$env:PICKLE_AUTO_ANSWER_BUSY_RETRY_MS="2500"
```

## Горячие клавиши

```text
Ctrl + \      Показать или скрыть основное overlay-окно
Ctrl + Enter  Задать вопрос AI с учетом экрана и аудио-контекста
Ctrl + Arrow  Переместить overlay-окно
```

## Сборка установщика Windows

Сначала установите зависимости, затем выполните:

```powershell
npm run build:win
```

Собранные файлы появятся в папке:

```text
dist\
```

Для локальной unpacked-сборки:

```powershell
npm run package
```

## Развертывание из исходников

Чтобы развернуть RepGlass на новом ПК:

1. Установите Git, Node.js 24, npm 11, Python и Visual Studio Build Tools.
2. Склонируйте `https://github.com/LaRsonOFFai/RepGlass.git`.
3. Выполните `npm install`.
4. Выполните `cd pickleglass_web && npm install && npm run build && cd ..`.
5. Запустите `npm start` для разработки или `npm run build:win` для сборки
   установщика.
6. Настройте AI-провайдеры внутри Settings.
7. Для ответов через Codex установите Codex CLI, выполните `codex login` и
   выберите `OpenAI Codex Auth` как LLM-провайдер.

## Структура проекта

```text
src/                 Основное Electron-приложение, сервисы, окна, UI
src/features/listen  Прослушивание, STT, транскрипция, автоответы
src/features/ask     Логика Ask/answer
src/features/common  AI-провайдеры, авторизация, состояние моделей
src/window           Overlay-окна и tray-менеджер
pickleglass_web/     Web/login-часть проекта
docs/                Заметки по Codex Auth и subscription gateway
scripts/             Helper-скрипты запуска для Windows
glass-openai/        Экспериментальный чистый Electron/Vite-прототип
```

## Невидимость при демонстрации экрана

RepGlass включает Electron `contentProtection` для своих окон. Это помогает
скрывать окно приложения от обычной записи экрана и демонстрации экрана в тех
случаях, где Windows и конкретная программа для звонков поддерживают такую
защиту.

Обязательно проверьте это именно в той программе, где планируете использовать
RepGlass. Некоторые приложения, драйверы, capture-card устройства, удаленные
рабочие столы или корпоративные политики могут обходить стандартную защиту ОС.

## Разработка

Собрать только renderer Electron:

```powershell
npm run build:renderer
```

Собрать все локальные frontend-части:

```powershell
npm run build:all
```

Запустить форматирование вручную:

```powershell
npx prettier --write .
```

## Частые проблемы

Если overlay-окно не видно:

- Проверьте иконку RepGlass в трее и выберите show/open.
- Закройте старые процессы `electron.exe` и снова выполните `npm start`.
- Если запускали скрыто, проверьте лог `%LOCALAPPDATA%\RepGlass\repglass-hidden.log`.

Если транскрипция пустая:

- Проверьте разрешения Windows для микрофона.
- Попробуйте `Whisper (Local)` с моделью `whisper-small`.
- Убедитесь, что у выбранного cloud-STT провайдера введен корректный API-ключ.
- Говорите несколько секунд подряд, чтобы аудио-фрагмент был достаточно длинным.

Если Codex Auth недоступен:

- Выполните `codex --version`.
- Выполните `codex login`.
- Выполните `codex login status`.
- Перезапустите RepGlass и выберите `OpenAI Codex Auth` как LLM-провайдер.

## Лицензия

GPL-3.0. Проект сохраняет лицензию исходной кодовой базы Glass.
