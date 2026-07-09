import OpenAI from 'openai';
import { SYSTEM_PROMPT } from './defaults';
import type { AppSettings } from './types';

export class OpenAIService {
  async validateApiKey(apiKey: string): Promise<{ success: true } | { success: false; error: string }> {
    const key = apiKey.trim();
    if (!key.startsWith('sk-')) {
      return { success: false, error: 'OpenAI API key must start with sk-' };
    }

    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (response.ok) return { success: true };
      const body = await response.json().catch(() => ({}));
      return { success: false, error: body?.error?.message || `OpenAI rejected the key (${response.status})` };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  }

  async answerQuestion(params: {
    apiKey: string;
    question: string;
    conversation: string[];
    settings: AppSettings;
  }): Promise<string> {
    const client = new OpenAI({ apiKey: params.apiKey });
    const context = params.conversation.slice(-20).join('\n');
    const input = [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          'Recent transcript:',
          context || 'No transcript yet.',
          '',
          'Latest question or request:',
          params.question,
        ].join('\n'),
      },
    ];

    try {
      const response = await client.responses.create({
        model: params.settings.model,
        input,
      } as never);

      const outputText = (response as { output_text?: string }).output_text;
      if (outputText?.trim()) return outputText.trim();

      return this.extractResponsesText(response);
    } catch (error) {
      console.warn('[OpenAIService] Responses API failed, falling back to chat completions:', error);
      const fallback = await client.chat.completions.create({
        model: params.settings.model,
        messages: input as never,
        temperature: 0.2,
      });
      return fallback.choices[0]?.message?.content?.trim() || 'No answer returned.';
    }
  }

  private extractResponsesText(response: unknown): string {
    const output = (response as { output?: Array<{ content?: Array<{ text?: string }> }> }).output || [];
    const text = output
      .flatMap((item) => item.content || [])
      .map((content) => content.text || '')
      .join('\n')
      .trim();
    return text || 'No answer returned.';
  }

}
