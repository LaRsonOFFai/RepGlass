import OpenAI from 'openai';
import fs from 'node:fs';
import { buildAssistantInstructions } from './defaults';
import type { AppSettings } from './types';

type ResponseStreamEvent = {
  type?: string;
  delta?: string;
  response?: unknown;
};

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
    imagePath?: string;
    onDelta?: (text: string) => void;
  }): Promise<string> {
    const client = new OpenAI({ apiKey: params.apiKey });
    const context = params.conversation.slice(-20).join('\n');
    const userText = [
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

  private imageDataUrl(imagePath: string): string {
    return `data:image/png;base64,${fs.readFileSync(imagePath).toString('base64')}`;
  }
}
