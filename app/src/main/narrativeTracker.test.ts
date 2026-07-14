import { describe, expect, it } from 'vitest';
import { DEFAULT_INTERVIEW_CONTEXT } from './interviewContext';
import { NarrativeTracker, buildNarrativeBlocks } from './narrativeTracker';

const state = {
  ...DEFAULT_INTERVIEW_CONTEXT,
  candidateText: [
    '## Коротко о себе\nЯ шесть лет занимаюсь автоматизацией тестирования.',
    '## Последний проект\nНа последнем проекте я отвечал за архитектуру API и UI автотестов.',
    '## CI/CD\nЯ подключил Playwright тесты к GitLab CI и настроил параллельные пайплайны.',
    '## Результат\nРегрессионный прогон сократился с четырёх часов до сорока минут.',
  ].join('\n\n'),
};

describe('dynamic narrative tracker', () => {
  it('splits a prepared story into stable semantic blocks', () => {
    const blocks = buildNarrativeBlocks(state.candidateText);

    expect(blocks.map((block) => block.title)).toEqual([
      'Коротко о себе',
      'Последний проект',
      'CI/CD',
      'Результат',
    ]);
    expect(blocks.every((block, index) => block.index === index && block.id.startsWith(`story-${index}-`))).toBe(true);
  });

  it('advances as candidate speech covers the active story block', () => {
    const tracker = new NarrativeTracker();
    const opened = tracker.onInterviewerQuestion(state, 'Расскажите немного о себе');
    const firstId = opened?.blocks[0].id;

    const advanced = tracker.onCandidateSpeech(state, 'Я шесть лет занимаюсь автоматизацией тестирования.');

    expect(advanced?.coveredBlockIds).toContain(firstId);
    expect(advanced?.activeBlockId).toBe(advanced?.blocks[1].id);
    expect(advanced?.progressPercent).toBe(25);
  });

  it('branches to a follow-up and returns to the interrupted story position', () => {
    const tracker = new NarrativeTracker();
    tracker.onInterviewerQuestion(state, 'Расскажите о себе');
    const afterIntro = tracker.onCandidateSpeech(state, 'Я шесть лет занимаюсь автоматизацией тестирования.');
    const projectId = afterIntro?.activeBlockId;

    const branch = tracker.onInterviewerQuestion(state, 'Как именно вы настраивали GitLab CI и пайплайны?');
    expect(branch?.mode).toBe('branching');
    expect(branch?.blocks.find((block) => block.id === branch.activeBlockId)?.title).toBe('CI/CD');
    expect(branch?.resumeBlockId).toBe(projectId);

    const resumed = tracker.onCandidateSpeech(
      state,
      'Я подключил Playwright тесты к GitLab CI и настроил параллельные пайплайны.',
    );
    expect(resumed?.mode).toBe('narrating');
    expect(resumed?.activeBlockId).toBe(projectId);
    expect(resumed?.resumeBlockId).toBeUndefined();
  });

  it('keeps a manually pinned block visible until it is unpinned', () => {
    const tracker = new NarrativeTracker();
    const initial = tracker.getProgress(state);
    const resultId = initial?.blocks[3].id;
    tracker.navigate(state, { action: 'select', blockId: resultId });

    const pinned = tracker.onCandidateSpeech(state, 'Я шесть лет занимаюсь автоматизацией тестирования.');
    expect(pinned?.activeBlockId).toBe(resultId);
    expect(pinned?.pinnedBlockId).toBe(resultId);

    const unpinned = tracker.navigate(state, { action: 'unpin' });
    expect(unpinned?.pinnedBlockId).toBeUndefined();
  });
});
