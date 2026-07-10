import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

let electronApp: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: ['.'],
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      REPGLASS_E2E: 'true',
      REPGLASS_USER_DATA_DIR: path.join(os.tmpdir(), `repglass-e2e-${process.pid}`),
    },
  });
  page = await electronApp.firstWindow();
  await page.locator('.workspace-panel').waitFor();
});

test.afterAll(async () => {
  await electronApp.close();
});

test('renders one usable translucent workspace', async ({ browserName: _browserName }, testInfo) => {
  expect(electronApp.windows()).toHaveLength(1);
  await expect(page.locator('.command-capsule')).toBeVisible();
  await expect(page.locator('.workspace-panel')).toBeVisible();
  const captureProtected = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.isContentProtected(),
  );
  expect(captureProtected).toBe(true);

  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    bodyHeight: document.body.scrollHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  }));
  expect(dimensions.bodyWidth).toBeLessThanOrEqual(dimensions.viewportWidth);
  expect(dimensions.bodyHeight).toBeLessThanOrEqual(dimensions.viewportHeight);
  await page.screenshot({ path: testInfo.outputPath('repglass-main.png') });
});

test('opens transcript and every personalization section', async ({ browserName: _browserName }, testInfo) => {
  const backButton = page.getByRole('button', { name: 'Вернуться' });
  if (await backButton.isVisible()) await backButton.click();
  await page.getByRole('button', { name: 'Текст' }).click();
  await expect(page.getByText('Транскрипция пуста')).toBeVisible();

  await page.getByTitle('Настройки и авторизация').click();
  for (const section of ['Подключение', 'Профиль']) {
    await page.getByRole('button', { name: section }).click();
  }
  await page.getByRole('button', { name: 'Аудио' }).click();
  await expect(page.getByRole('button', { name: 'Оба источника' })).toHaveClass(/active/);
  await page.screenshot({ path: testInfo.outputPath('repglass-audio.png') });
  await page.getByRole('button', { name: 'Приватность' }).click();
  await expect(page.getByText('Ключ API шифруется через Windows DPAPI.')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('repglass-settings.png') });
  await page.getByRole('button', { name: 'Вернуться' }).click();
  await page.getByRole('button', { name: 'Итоги' }).click();
  await expect(page.getByText('Итоги текущей сессии')).toBeVisible();
  await page.waitForTimeout(120);
  await page.screenshot({ path: testInfo.outputPath('repglass-summary.png') });
});

test('captures a protected screen preview in the same window', async ({ browserName: _browserName }, testInfo) => {
  if (!(await page.locator('.ask-panel').isVisible())) await page.getByRole('button', { name: 'Ask' }).click();
  const visibilitySamples = electronApp.evaluate(async ({ BrowserWindow }) => {
    const samples: boolean[] = [];
    for (let index = 0; index < 50; index += 1) {
      samples.push(Boolean(BrowserWindow.getAllWindows()[0]?.isVisible()));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return samples;
  });
  await page.getByTitle('Добавить экран к запросу').click();
  const preview = page.locator('.composer-preview');
  await expect(preview).toBeVisible();
  expect(await visibilitySamples).toContain(false);
  const windowState = await electronApp.evaluate(({ BrowserWindow }) => ({
    visible: BrowserWindow.getAllWindows()[0]?.isVisible(),
    focusable: BrowserWindow.getAllWindows()[0]?.isFocusable(),
  }));
  expect(windowState).toEqual({ visible: true, focusable: true });
  const input = page.getByPlaceholder('Задать вопрос...');
  await input.fill('Проверка текстового Ask');
  await expect(input).toHaveValue('Проверка текстового Ask');
  await expect(input).toHaveAttribute('title', /Ctrl\+Shift\+Q.*Ctrl\+Enter/);
  await expect(preview).toHaveAttribute('src', /^data:image\/png;base64,/);
  expect(electronApp.windows()).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('repglass-screen-context.png') });
});

test('keeps the screenshot attached to the answer that used it', async ({ browserName: _browserName }, testInfo) => {
  const request = {
    id: 'screen-request-e2e',
    question: 'Исправь ошибку в коде на экране',
    trigger: 'hotkey',
    sources: ['audio', 'screen'],
    createdAt: Date.now(),
    speaker: 'them',
    transcriptTurnIds: ['system:e2e'],
    screen: {
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      displayName: 'Основной экран',
    },
  };
  const answer = {
    id: request.id,
    request,
    question: request.question,
    answer: 'Проверить условие и обработать пустое значение перед обращением к свойству.',
    createdAt: Date.now(),
    category: 'screen',
    usedScreen: true,
  };

  await electronApp.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('ask:request', payload.request);
    BrowserWindow.getAllWindows()[0]?.webContents.send('ask:answer', payload.answer);
  }, { request, answer });

  await expect(page.getByText('Исправь ошибку в коде на экране')).toBeVisible();
  await expect(page.getByText('Аудио')).toBeVisible();
  await expect(page.getByText('Экран', { exact: true })).toBeVisible();
  await expect(page.locator('.request-screen img')).toBeVisible();
  await expect(page.getByText(/Анализ экрана · Основной экран/)).toBeVisible();
  await expect(page.getByText(/Проверить условие/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('repglass-anchored-screen-answer.png') });
});

test('reflows Listen and Ask without overlap in a narrow overlay', async ({ browserName: _browserName }, testInfo) => {
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(520, 620));
  await page.waitForTimeout(180);

  const layout = await page.evaluate(() => {
    const listen = document.querySelector('.listen-panel')?.getBoundingClientRect();
    const ask = document.querySelector('.ask-panel')?.getBoundingClientRect();
    return {
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
      listenBottom: listen?.bottom || 0,
      askTop: ask?.top || 0,
    };
  });
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.askTop).toBeGreaterThanOrEqual(layout.listenBottom);
  await page.screenshot({ path: testInfo.outputPath('repglass-narrow-workspace.png') });

  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(980, 620));
});

test('streams a live Codex answer with screen context', async () => {
  test.skip(process.env.REPGLASS_LIVE_CODEX !== '1', 'Live Codex smoke test is opt-in');
  test.setTimeout(120_000);
  if (!(await page.locator('.ask-panel').isVisible())) await page.getByRole('button', { name: 'Ask' }).click();
  await page.getByTitle('Добавить экран к запросу').click();
  const input = page.getByPlaceholder('Задать вопрос...');
  await input.fill('Ответь одним словом: сколько будет два плюс два?');
  await page.getByTitle('Отправить').click();
  const card = page.locator('.answer-detail').first();
  await expect(card).toBeVisible({ timeout: 90_000 });
  await expect(card.locator('.markdown-answer')).not.toBeEmpty();
  await expect(card).not.toHaveClass(/streaming/, { timeout: 90_000 });
});
