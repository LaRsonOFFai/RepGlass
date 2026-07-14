import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INTERVIEW_CONTEXT,
  buildInterviewCoach,
  buildInterviewContextPacket,
  normalizeInterviewContext,
} from './interviewContext';

const context = normalizeInterviewContext({
  ...DEFAULT_INTERVIEW_CONTEXT,
  candidateTitle: 'Senior AQA',
  candidateText: [
    'Я шесть лет работаю в автоматизации тестирования.',
    'На последнем проекте построил API-тесты на TypeScript и Playwright, подключил их к GitLab CI.',
    'Сократил регрессионный прогон с четырёх часов до сорока минут.',
  ].join('\n\n'),
  vacancyTitle: 'Senior QA Automation Engineer',
  vacancyText: 'Ищем инженера со знанием TypeScript, Playwright, API, CI/CD и опытом развития тестовой архитектуры.',
});

describe('interview context', () => {
  it('selects candidate and vacancy facts for a personal project question', () => {
    const packet = buildInterviewContextPacket(context, 'Расскажите о проекте с Playwright и вашем результате');

    expect(packet.prompt).toContain('Профиль кандидата');
    expect(packet.prompt).toContain('Целевая вакансия: Senior QA Automation Engineer');
    expect(packet.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'candidate' }),
        expect.objectContaining({ kind: 'vacancy' }),
      ]),
    );
  });

  it('opens the prepared narrative for a tell-me-about-yourself question', () => {
    const coach = buildInterviewCoach(context, 'Расскажите немного о себе');

    expect(coach.topic).toBe('Рассказ о себе');
    expect(coach.showNarrative).toBe(true);
    expect(coach.narrative).toContain('шесть лет');
    expect(coach.likelyQuestions.length).toBeGreaterThan(0);
  });

  it('keeps imported materials bounded and removes empty documents', () => {
    const normalized = normalizeInterviewContext({
      documents: [
        { id: 'empty', name: 'Empty', kind: 'candidate', sourceType: 'text', content: '  ', createdAt: 1 },
        { id: 'large', name: 'Large', kind: 'interview', sourceType: 'text', content: 'x'.repeat(130_000), createdAt: 2 },
      ],
    });

    expect(normalized.documents).toHaveLength(1);
    expect(normalized.documents[0].content).toHaveLength(100_000);
  });

  it('can disable model context while keeping local coaching state', () => {
    const packet = buildInterviewContextPacket({ ...context, enabled: false }, 'Почему эта вакансия?');

    expect(packet.prompt).toBe('');
    expect(packet.references).toEqual([]);
    expect(packet.coach.vacancyReady).toBe(true);
  });
});
