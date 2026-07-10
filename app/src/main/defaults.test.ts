import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, buildAssistantInstructions, normalizeSettings } from './defaults';

describe('settings', () => {
  it('migrates incomplete and invalid settings', () => {
    const settings = normalizeSettings({
      answerCooldownMs: -20,
      captureSource: 'microphone',
      codexModel: '',
      transcriptionModel: 'whisper-1',
    } as never);

    expect(settings.answerCooldownMs).toBe(2_000);
    expect(settings.captureSource).toBe('microphone');
    expect(settings.codexModel).toBe(DEFAULT_SETTINGS.codexModel);
    expect(settings.transcriptionModel).toBe('gpt-realtime-whisper');
  });

  it('builds a QA-specific prompt', () => {
    const prompt = buildAssistantInstructions(
      normalizeSettings({ profile: 'aqa', customInstructions: 'Используй Playwright.' }),
    );
    expect(prompt).toContain('senior AQA');
    expect(prompt).toContain('Playwright');
  });
});
