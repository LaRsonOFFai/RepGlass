/* global document */
import { _electron as electron, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(appRoot, '../docs/screenshots');
const temporaryData = await fs.mkdtemp(path.join(os.tmpdir(), 'repglass-screenshots-'));
let application;

try {
  await fs.mkdir(output, { recursive: true });
  application = await electron.launch({
    args: ['.'],
    cwd: appRoot,
    env: {
      ...process.env,
      REPGLASS_USER_DATA_DIR: path.join(temporaryData, 'user-data'),
      CODEX_HOME: path.join(temporaryData, 'codex'),
    },
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.locator('.settings-workspace').waitFor();
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(980, 620);
    window.setAlwaysOnTop(false);
  });

  async function capture(name) {
    await page.evaluate(async () => {
      await document.fonts.ready;
      document.querySelectorAll('.settings-scroll, .transcript-view, .ask-history').forEach((element) => {
        element.scrollTop = 0;
      });
    });
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(output, name), animations: 'disabled', omitBackground: true });
    console.log(`Saved docs/screenshots/${name}`);
  }

  await page.getByRole('button', { name: 'Аудио', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Оба источника', exact: true })).toBeVisible();
  await capture('audio.png');

  await page.getByRole('button', { name: 'Приватность', exact: true }).click();
  await expect(page.getByText('Ключ API шифруется через Windows DPAPI.')).toBeVisible();
  await capture('privacy.png');

  await page.getByRole('button', { name: 'Профиль', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(980, 1100));
  await page.getByPlaceholder('Например: Senior AQA').fill('Senior AQA');
  await page.getByPlaceholder(/Расскажите о себе в подготовленном формате/).fill(
    'Коротко о себе\nШесть лет автоматизирую API и UI. Работаю с TypeScript и Playwright.\n\nПоследний проект\nРазвивал автотесты сервиса заказов и интеграцию с GitLab CI.\n\nРезультат\nСократил регресс с четырёх часов до сорока минут.',
  );
  await page.getByPlaceholder('Название вакансии').fill('QA Automation Engineer');
  await page.getByPlaceholder('Вставьте описание вакансии целиком...').fill(
    'Разработка API- и UI-автотестов на TypeScript и Playwright. Развитие CI/CD, анализ нестабильных тестов и работа с командой разработки.',
  );
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByText(/Сохранено/)).toBeVisible();
  await capture('profile.png');

  await page.getByRole('button', { name: 'Вернуться', exact: true }).click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(980, 740));
  // Feed the same renderer events as a real session, using only fictional data.
  // No microphone, desktop capture, login or paid model request is needed.
  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const createdAt = new Date('2026-10-02T09:00:00Z').getTime();
    const turns = [
      { id: 'demo-1', speaker: 'them', text: 'Расскажите, как вы боретесь с нестабильными UI-тестами.' },
      { id: 'demo-2', speaker: 'me', text: 'Начинаю с трассировки и логов. Проверяю локаторы, ожидания и изоляцию тестовых данных.' },
      { id: 'demo-3', speaker: 'them', text: 'Когда стоит использовать retry в Playwright?' },
    ];
    turns.forEach((turn, index) => contents.send('listen:transcript', { ...turn, createdAt: createdAt + index * 30_000 }));
    const request = {
      id: 'demo-answer', question: turns[2].text, trigger: 'auto', sources: ['audio'],
      speaker: 'them', transcriptTurnIds: ['demo-3'], createdAt: createdAt + 60_000,
    };
    contents.send('ask:request', request);
    contents.send('ask:answer', {
      id: request.id, request, question: request.question, category: 'testing', usedScreen: false,
      createdAt: request.createdAt,
      answer: '**Retry — страховка от временных сбоев окружения.** Сначала нужно найти и устранить причину нестабильности.\n\n- Используйте устойчивые локаторы и web-first assertions.\n- Изолируйте данные и состояние каждого теста.\n- Сохраняйте trace при первом повторе и разбирайте flaky-тесты отдельно.\n\nВ CI достаточно одного-двух повторов: постоянные сбои должны оставаться видимыми.',
    });
    contents.send('session:phase', { phase: 'paused' });
    contents.send('status', 'На паузе');
  });
  await expect(page.locator('.markdown-answer').filter({ hasText: 'Retry' })).toBeVisible();
  await capture('workspace.png');

  await application.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.send('session:summary', {
      text: '## Итоги интервью\n\nОбсудили стабильность UI-автотестов и стратегию повторных запусков в CI.\n\n### Сильные стороны\n- Системный поиск причин: trace, логи, локаторы и данные.\n- Практический опыт с TypeScript, Playwright и GitLab CI.\n\n### Что подготовить\n- Пример устранения flaky-теста с измеримым результатом.\n- Подход к мониторингу нестабильности в CI.',
      createdAt: new Date('2026-10-02T09:03:00Z').getTime(), transcriptCount: 3, answerCount: 1,
    });
    contents.send('session:phase', { phase: 'finished' });
  });
  await page.getByRole('button', { name: 'Итоги', exact: true }).click();
  await expect(page.locator('.summary-view')).toBeVisible();
  await capture('summary.png');
} finally {
  if (application) await application.close();
  await fs.rm(temporaryData, { recursive: true, force: true });
}
