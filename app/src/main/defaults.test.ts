import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  buildAssistantInstructions,
  migrateSettings,
  normalizeSettings,
} from './defaults';

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

  it('uses both audio sources and migrates the previous system-only default once', () => {
    expect(DEFAULT_SETTINGS.captureSource).toBe('both');
    expect(normalizeSettings(migrateSettings({ captureSource: 'system' }, 1)).captureSource).toBe('both');
    expect(
      normalizeSettings(migrateSettings({ captureSource: 'system' }, SETTINGS_SCHEMA_VERSION)).captureSource,
    ).toBe('system');
    expect(normalizeSettings({ captureSource: 'microphone' }).captureSource).toBe('microphone');
  });
});
