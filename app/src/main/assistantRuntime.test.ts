import { describe, expect, it, vi } from 'vitest';
import { AssistantRuntime } from './assistantRuntime';
import type { CodexService } from './codexService';
import { DEFAULT_SETTINGS } from './defaults';

function createRuntime() {
  const events: Array<{ channel: string; payload: unknown }> = [];
  const answerQuestion = vi.fn().mockResolvedValue('Подготовленный ответ');
  const resetConversation = vi.fn();
  const dispose = vi.fn();
  const captureScreen = vi.fn().mockResolvedValue({
    path: 'C:\\Temp\\screen.png',
    dataUrl: 'data:image/png;base64,AA==',
    displayName: 'Screen 1',
    dispose,
  });
  const codex = { answerQuestion, resetConversation } as unknown as CodexService;
  const runtime = new AssistantRuntime({
    codex,
    getApiKey: () => 'sk-test',
    getSettings: () => ({ ...DEFAULT_SETTINGS, answerProvider: 'codex', screenContext: 'off' }),
    webContents: () =>
      ({
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => events.push({ channel, payload }),
      }) as never,
    captureScreen,
  });
  return { runtime, answerQuestion, resetConversation, captureScreen, dispose, events };
}

type RuntimeInternals = {
  handleFinalTranscript: (source: 'microphone' | 'system', id: string, text: string) => Promise<void>;
};

describe('assistant session workflow', () => {
  it('keeps both speakers in context and auto-answers only the interviewer', async () => {
    const { runtime, answerQuestion, events } = createRuntime();
    const internals = runtime as unknown as RuntimeInternals;

    await internals.handleFinalTranscript('microphone', 'me-1', 'Я использовал Playwright в последнем проекте.');
    expect(answerQuestion).not.toHaveBeenCalled();

    await internals.handleFinalTranscript('system', 'them-1', 'Что такое REST API?');
    expect(answerQuestion).toHaveBeenCalledOnce();
    expect(answerQuestion.mock.calls[0][0].conversation).toEqual([
      'Вы: Я использовал Playwright в последнем проекте.',
      'Собеседник: Что такое REST API?',
    ]);
    expect(events.filter((event) => event.channel === 'listen:transcript').map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ speaker: 'me' }),
        expect.objectContaining({ speaker: 'them' }),
      ]),
    );

    await runtime.ask({ question: 'Приведи пример.' });
    expect(answerQuestion.mock.calls[1][0].conversation).toEqual(
      expect.arrayContaining(['Вопрос: Что такое REST API?', 'Ответ RepGlass: Подготовленный ответ']),
    );
  });

  it('uses a protected screen-only fallback for smart submit without text or audio', async () => {
    const { runtime, answerQuestion, captureScreen, dispose } = createRuntime();

    const answer = await runtime.askSmart();

    expect(captureScreen).toHaveBeenCalledOnce();
    expect(answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        question: expect.stringContaining('снимок экрана'),
        imagePath: 'C:\\Temp\\screen.png',
      }),
    );
    expect(answer.usedScreen).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('clears local context and starts a fresh Codex thread', async () => {
    const { runtime, resetConversation } = createRuntime();
    await runtime.ask({ question: 'Первый вопрос' });

    runtime.clearSession();

    expect(runtime.getSessionState()).toEqual({ transcript: [], answers: [], summary: null });
    expect(resetConversation).toHaveBeenCalledOnce();
  });

  it('builds session summary from the accumulated launch context', async () => {
    const { runtime, answerQuestion, events } = createRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    answerQuestion.mockResolvedValueOnce('## Итоги\nОбсудили автоматизацию API.');
    await internals.handleFinalTranscript('system', 'them-2', 'Мы обсудили автоматизацию API.');

    const summary = await runtime.summarizeSession();

    expect(answerQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ conversation: ['Собеседник: Мы обсудили автоматизацию API.'] }),
    );
    expect(summary).toEqual(
      expect.objectContaining({ text: expect.stringContaining('Итоги'), transcriptCount: 1, answerCount: 0 }),
    );
    expect(events).toContainEqual(expect.objectContaining({ channel: 'session:summary', payload: summary }));
  });

  it('does not truncate launch context to the last twenty transcript turns', async () => {
    const { runtime, answerQuestion } = createRuntime();
    const internals = runtime as unknown as RuntimeInternals;
    for (let index = 1; index <= 25; index += 1) {
      await internals.handleFinalTranscript('microphone', `me-${index}`, `Моя реплика номер ${index}.`);
    }

    await internals.handleFinalTranscript('system', 'them-final', 'Какие выводы можно сделать?');

    const conversation = answerQuestion.mock.calls[0][0].conversation as string[];
    expect(conversation).toHaveLength(26);
    expect(conversation[0]).toBe('Вы: Моя реплика номер 1.');
    expect(conversation.at(-1)).toBe('Собеседник: Какие выводы можно сделать?');
  });
});
