import { describe, expect, it } from 'vitest';
import { selectAnswerModels } from './openaiService';

describe('OpenAI answer model catalog', () => {
  it('prioritizes current interview models and removes incompatible endpoints', () => {
    const models = selectAnswerModels([
      'gpt-realtime-2.1',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-live-transcribe',
      'gpt-image-2',
      'gpt-6-luna-2026-09-22',
      'gpt-7-luna',
      'gpt-4.1',
    ]);

    expect(models.map((model) => model.id)).toEqual(['gpt-6-luna', 'gpt-6-sol', 'gpt-7-luna']);
    expect(models[0]?.name).toContain('экономно');
  });
});
