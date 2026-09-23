import OpenAI from 'openai';
import fs from 'node:fs';
import { buildAssistantInstructions } from './defaults';
import type { AppSettings } from './types';

type ResponseStreamEvent = {
  type?: string;
  delta?: string;
  response?: unknown;
};

export type OpenAIModel = {
  id: string;
  name: string;
};

const RECOMMENDED_ANSWER_MODELS: Array<OpenAIModel> = [
  { id: 'gpt-6-luna', name: 'GPT-6 Luna · быстро и экономно' },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol · код и сложные задачи' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra · максимум качества' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna · экономно' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra · баланс' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol · высокая точность' },
  { id: 'gpt-5.6', name: 'GPT-5.6 · актуальный alias' },
];

export class OpenAIService {
  async validateApiKey(apiKey: string): Promise<{ success: true } | { success: false; error: string }> {
    const key = apiKey.trim();
    if (!key.startsWith('sk-')) return { success: false, error: 'OpenAI API key должен начинаться с sk-' };

    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (response.ok) return { success: true };
      const body = await response.json().catch(() => ({}));
      return { success: false, error: body?.error?.message || `OpenAI отклонил ключ (${response.status})` };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Ошибка сети' };
    }
  }

  async answerQuestion(params: {
    apiKey: string;
    question: string;
    conversation: string[];
    settings: AppSettings;
    interviewContext?: string;
    imagePath?: string;
    onDelta?: (text: string) => void;
  }): Promise<string> {
    const client = new OpenAI({ apiKey: params.apiKey });
    const context = params.conversation.join('\n');
    const userText = [
      params.interviewContext || '',
      'Недавняя транскрипция:',
      context || 'Транскрипции пока нет.',
      '',
      'Последний вопрос:',
      params.question,
    ].join('\n');
    const userContent: Array<Record<string, unknown>> = [{ type: 'input_text', text: userText }];
    const imageDataUrl = params.imagePath ? this.imageDataUrl(params.imagePath) : null;
    if (imageDataUrl) userContent.push({ type: 'input_image', image_url: imageDataUrl, detail: 'auto' });

    try {
      const stream = (await client.responses.create({
        model: params.settings.model,
        instructions: buildAssistantInstructions(params.settings),
        input: [{ role: 'user', content: userContent }],
        reasoning: { effort: params.settings.reasoningEffort },
        stream: true,
      } as never)) as unknown as AsyncIterable<ResponseStreamEvent>;
      let answer = '';
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta' && event.delta) {
          answer += event.delta;
          params.onDelta?.(answer);
        }
      }
      if (answer.trim()) return answer.trim();
      throw new Error('OpenAI вернул пустой ответ');
    } catch (error) {
      console.warn('[OpenAIService] Responses API failed, falling back to chat completions:', error);
      const content: Array<Record<string, unknown>> = [{ type: 'text', text: userText }];
      if (imageDataUrl) content.push({ type: 'image_url', image_url: { url: imageDataUrl, detail: 'auto' } });
      const fallback = await client.chat.completions.create({
        model: params.settings.model,
        messages: [
          { role: 'system', content: buildAssistantInstructions(params.settings) },
          { role: 'user', content },
        ] as never,
      });
      const answer = fallback.choices[0]?.message?.content?.trim() || 'OpenAI не вернул ответ.';
      params.onDelta?.(answer);
      return answer;
    }
  }

  async listModels(apiKey: string): Promise<OpenAIModel[]> {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
    });
    const body = (await response.json().catch(() => ({}))) as {
      data?: Array<{ id?: string }>;
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(body.error?.message || `Не удалось загрузить модели (${response.status})`);
    return selectAnswerModels((body.data || []).map((model) => model.id || ''));
  }

  async transcribeFile(apiKey: string, filePath: string, language?: string): Promise<string> {
    const client = new OpenAI({ apiKey });
    const result = await client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'gpt-transcribe',
      ...(language && language !== 'auto' ? { language } : {}),
    });
    const text = result.text.trim();
    if (!text) throw new Error('OpenAI не вернул текст расшифровки');
    return text;
  }

  private imageDataUrl(imagePath: string): string {
    return `data:image/png;base64,${fs.readFileSync(imagePath).toString('base64')}`;
  }
}

export function selectAnswerModels(modelIds: string[]): OpenAIModel[] {
  const available = new Set(modelIds.filter(Boolean));
  const recommended = RECOMMENDED_ANSWER_MODELS.filter((model) => available.has(model.id));
  const recommendedIds = new Set(recommended.map((model) => model.id));
  const discovered = [...available]
    .filter((id) => !recommendedIds.has(id) && isCompatibleAnswerModel(id))
    .sort((left, right) => right.localeCompare(left, 'en'))
    .map((id) => ({ id, name: id }));
  return [...recommended, ...discovered];
}

function isCompatibleAnswerModel(id: string): boolean {
  const family = /^gpt-(\d+)/.exec(id);
  if (!family || Number(family[1]) < 5) return false;
  if (/-\d{4}-\d{2}-\d{2}$/.test(id)) return false;
  return !/(?:audio|chat|codex|cyber|image|instruct|moderation|realtime|search|transcribe|tts)/i.test(id);
}
