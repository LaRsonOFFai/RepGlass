import { describe, expect, it } from 'vitest';
import { classifyQuestion, shouldAttachScreen, shouldAutoAnswer, signatureFor } from './questionDetector';

describe('question detector', () => {
  it.each([
    'Как сделать попкорн',
    'Объясни разницу между smoke и regression тестированием',
    'What is the time complexity of binary search?',
    'Можешь написать пример на TypeScript',
  ])('detects a question: %s', (text) => {
    expect(shouldAutoAnswer(text)).toBe(true);
  });

  it.each(['Добрый день', 'Понятно', 'Спасибо за ответ'])('ignores a statement: %s', (text) => {
    expect(shouldAutoAnswer(text)).toBe(false);
  });

  it('detects screen context and categories', () => {
    expect(shouldAttachScreen('Реши задачу на экране')).toBe(true);
    expect(classifyQuestion('Почему этот TypeScript код падает?')).toBe('code');
    expect(classifyQuestion('Как составить нагрузочный профиль?')).toBe('testing');
    expect(classifyQuestion('Что видно на экране?', true)).toBe('screen');
  });

  it('normalizes signatures', () => {
    expect(signatureFor('  Как  сделать попкорн?! ')).toBe('как сделать попкорн');
  });
});
