import crypto from 'node:crypto';
import type {
  InterviewContextState,
  NarrativeNavigationRequest,
  NarrativeProgressBlock,
  NarrativeProgressPayload,
} from './types';

type NarrativeSourceBlock = {
  id: string;
  index: number;
  title: string;
  text: string;
  tokens: Set<string>;
};

const SELF_NARRATIVE_RE =
  /(?:расскаж[\p{L}]*\s+(?:немного\s+)?о\s+себе|представьтесь|ваш[\p{L}]*\s+опыт|чем\s+вы\s+занимались|tell\s+me\s+about\s+yourself|introduce\s+yourself)/iu;

const STOP_WORDS = new Set([
  'about', 'and', 'from', 'have', 'that', 'the', 'this', 'what', 'when', 'where', 'with',
  'была', 'были', 'было', 'быть', 'ваша', 'вашего', 'вашем', 'вашей', 'ваши', 'вашу', 'говорить', 'далее',
  'делали', 'затем', 'какие', 'какой', 'когда', 'который', 'меня', 'можете', 'нужно', 'очень', 'почему', 'после',
  'потом', 'работал', 'работала', 'работали', 'работы', 'расскажите', 'себе', 'также', 'такое', 'этого', 'этой',
  'этому', 'этот', 'этом', 'через', 'чтобы',
]);

export class NarrativeTracker {
  private fingerprint = '';
  private blocks: NarrativeSourceBlock[] = [];
  private readonly covered = new Set<string>();
  private readonly spokenTokens = new Set<string>();
  private activeBlockId: string | undefined;
  private resumeBlockId: string | undefined;
  private pinnedBlockId: string | undefined;
  private branchQuestion: string | undefined;
  private mode: NarrativeProgressPayload['mode'] = 'ready';

  getProgress(state: InterviewContextState): NarrativeProgressPayload | undefined {
    this.sync(state);
    if (!this.blocks.length) return undefined;
    if (!this.activeBlockId) this.activeBlockId = this.firstUncovered()?.id || this.blocks[0]?.id;
    return this.snapshot();
  }

  onInterviewerQuestion(state: InterviewContextState, question: string): NarrativeProgressPayload | undefined {
    this.sync(state);
    if (!this.blocks.length) return undefined;
    const current = this.currentBlock();
    if (SELF_NARRATIVE_RE.test(question)) {
      this.mode = 'narrating';
      this.resumeBlockId = undefined;
      this.branchQuestion = undefined;
      if (!this.pinnedBlockId) this.activeBlockId = this.firstUncovered()?.id || this.blocks[0]?.id;
      return this.snapshot();
    }

    const matched = this.bestBlock(question);
    if (matched && matched.score >= 2 && !this.pinnedBlockId) {
      const sequential = this.firstUncoveredAfter(current?.index ?? -1) || this.firstUncovered();
      const interruptsCurrent = current && matched.block.id !== current.id && !this.covered.has(current.id);
      if (interruptsCurrent || (current && matched.block.id !== current.id && matched.block.id !== sequential?.id)) {
        this.resumeBlockId = current.id;
        this.mode = 'branching';
      } else if (this.mode === 'ready') {
        this.mode = 'narrating';
      }
      this.activeBlockId = matched.block.id;
      this.branchQuestion = question;
    }
    return this.snapshot();
  }

  onCandidateSpeech(state: InterviewContextState, speech: string): NarrativeProgressPayload | undefined {
    this.sync(state);
    if (!this.blocks.length) return undefined;
    const speechTokens = tokens(speech);
    for (const token of speechTokens) this.spokenTokens.add(token);
    const matched = this.bestBlock(speech);

    if (matched && matched.score >= 2 && !this.pinnedBlockId) {
      this.activeBlockId = matched.block.id;
      if (this.mode === 'ready') this.mode = 'narrating';
    }

    for (const block of this.blocks) {
      const currentOverlap = intersectionSize(speechTokens, block.tokens);
      const cumulativeCoverage = coverage(this.spokenTokens, block.tokens);
      const threshold = Math.max(2, Math.min(4, Math.ceil(block.tokens.size * 0.22)));
      if (currentOverlap >= threshold || cumulativeCoverage >= 0.38) this.covered.add(block.id);
    }

    const active = this.currentBlock();
    if (active && this.covered.has(active.id) && !this.pinnedBlockId) {
      if (this.mode === 'branching' && this.resumeBlockId && active.id !== this.resumeBlockId) {
        this.activeBlockId = this.covered.has(this.resumeBlockId)
          ? this.firstUncoveredAfter(this.blockIndex(this.resumeBlockId))?.id || this.firstUncovered()?.id
          : this.resumeBlockId;
        this.resumeBlockId = undefined;
        this.branchQuestion = undefined;
        this.mode = 'narrating';
      } else {
        this.activeBlockId = this.firstUncoveredAfter(active.index)?.id || this.firstUncovered()?.id || active.id;
      }
    }
    return this.snapshot();
  }

  navigate(state: InterviewContextState, request: NarrativeNavigationRequest): NarrativeProgressPayload | undefined {
    this.sync(state);
    if (!this.blocks.length) return undefined;
    const currentIndex = this.blockIndex(this.activeBlockId);
    if (request.action === 'reset') {
      this.resetSession();
      this.sync(state);
      return this.getProgress(state);
    }
    if (request.action === 'pin') this.pinnedBlockId = this.activeBlockId;
    if (request.action === 'unpin') this.pinnedBlockId = undefined;
    if (request.action === 'previous') {
      this.clearBranch();
      this.pinnedBlockId = undefined;
      this.activeBlockId = this.blocks[Math.max(0, currentIndex - 1)]?.id;
    }
    if (request.action === 'next') {
      this.clearBranch();
      this.pinnedBlockId = undefined;
      this.activeBlockId = this.blocks[Math.min(this.blocks.length - 1, currentIndex + 1)]?.id;
    }
    if (request.action === 'select' && this.blocks.some((block) => block.id === request.blockId)) {
      this.clearBranch();
      this.activeBlockId = request.blockId;
      this.pinnedBlockId = request.blockId;
    }
    if (this.mode === 'ready') this.mode = 'narrating';
    return this.snapshot();
  }

  resetSession(): void {
    this.covered.clear();
    this.spokenTokens.clear();
    this.activeBlockId = undefined;
    this.resumeBlockId = undefined;
    this.pinnedBlockId = undefined;
    this.branchQuestion = undefined;
    this.mode = 'ready';
  }

  private sync(state: InterviewContextState): void {
    const source = narrativeSource(state);
    const fingerprint = crypto.createHash('sha1').update(source).digest('hex');
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    this.blocks = buildNarrativeBlocks(source);
    this.resetSession();
  }

  private snapshot(): NarrativeProgressPayload {
    const activeBlockId = this.pinnedBlockId || this.activeBlockId || this.firstUncovered()?.id || this.blocks[0]?.id;
    const activeIndex = this.blockIndex(activeBlockId);
    const next = this.firstUncoveredAfter(activeIndex) || this.firstUncovered();
    const blocks: NarrativeProgressBlock[] = this.blocks.map((block) => ({
      id: block.id,
      index: block.index,
      title: block.title,
      text: block.text,
      status: block.id === activeBlockId ? 'active' : this.covered.has(block.id) ? 'covered' : 'upcoming',
      coverage: Math.round(coverage(this.spokenTokens, block.tokens) * 100),
    }));
    return {
      mode: this.mode,
      blocks,
      coveredBlockIds: [...this.covered],
      activeBlockId,
      nextBlockId: next?.id,
      resumeBlockId: this.resumeBlockId,
      pinnedBlockId: this.pinnedBlockId,
      branchQuestion: this.branchQuestion,
      progressPercent: this.blocks.length ? Math.round((this.covered.size / this.blocks.length) * 100) : 0,
    };
  }

  private bestBlock(value: string): { block: NarrativeSourceBlock; score: number } | undefined {
    const query = tokens(value);
    if (!query.size) return undefined;
    return this.blocks
      .map((block) => ({
        block,
        score: weightedOverlap(query, block.tokens) + (block.id === this.activeBlockId ? 0.35 : 0),
      }))
      .sort((left, right) => right.score - left.score)[0];
  }

  private currentBlock(): NarrativeSourceBlock | undefined {
    return this.blocks.find((block) => block.id === (this.pinnedBlockId || this.activeBlockId));
  }

  private firstUncovered(): NarrativeSourceBlock | undefined {
    return this.blocks.find((block) => !this.covered.has(block.id));
  }

  private firstUncoveredAfter(index: number): NarrativeSourceBlock | undefined {
    return this.blocks.find((block) => block.index > index && !this.covered.has(block.id));
  }

  private blockIndex(blockId?: string): number {
    const index = this.blocks.findIndex((block) => block.id === blockId);
    return index >= 0 ? index : 0;
  }

  private clearBranch(): void {
    this.resumeBlockId = undefined;
    this.branchQuestion = undefined;
    this.mode = 'narrating';
  }
}

export function buildNarrativeBlocks(source: string): NarrativeSourceBlock[] {
  const sections = splitNarrative(source);
  return sections.map((text, index) => ({
    id: `story-${index}-${shortHash(text)}`,
    index,
    title: narrativeTitle(text, index),
    text: stripHeading(text),
    tokens: tokens(text),
  }));
}

function narrativeSource(state: InterviewContextState): string {
  if (state.candidateText.trim()) return state.candidateText.trim();
  return state.documents
    .filter((document) => document.kind === 'candidate')
    .map((document) => document.content.trim())
    .filter(Boolean)
    .join('\n\n');
}

function splitNarrative(source: string): string[] {
  const normalized = source.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  let sections = normalized
    .split(/\n{2,}|(?=^#{1,4}\s+)|(?=^[-*•]\s+)/gmu)
    .map((section) => section.trim())
    .filter(Boolean);
  if (sections.length === 1 && normalized.length > 520) {
    const sentences = normalized.split(/(?<=[.!?])\s+/u);
    sections = [];
    let current = '';
    for (const sentence of sentences) {
      if (current && current.length + sentence.length > 420) {
        sections.push(current);
        current = '';
      }
      current = current ? `${current} ${sentence}` : sentence;
    }
    if (current) sections.push(current);
  }
  return sections.slice(0, 30);
}

function narrativeTitle(text: string, index: number): string {
  const heading = text.match(/^#{1,4}\s+(.+)$/mu)?.[1]?.trim();
  if (heading) return heading.slice(0, 70);
  const plainHeading = getPlainHeading(text);
  if (plainHeading) return plainHeading.replace(/:$/u, '');
  if (/(?:результат|сократ|увелич|ускор|метрик|достижен)/iu.test(text)) return 'Результат';
  if (/(?:сложн|проблем|конфликт|инцидент|ошибк)/iu.test(text)) return 'Сложная ситуация';
  if (/(?:ci\/cd|gitlab|jenkins|pipeline|пайплайн)/iu.test(text)) return 'CI/CD';
  if (/(?:стек|технолог|playwright|selenium|typescript|java\b|python|api\b|sql\b)/iu.test(text)) return 'Технологии';
  if (/(?:обязанност|ответствен|роль|команд)/iu.test(text)) return 'Роль и обязанности';
  if (/(?:проект|продукт|систем)/iu.test(text)) return 'Проект';
  if (/(?:почему|мотивац|интерес|ваканси)/iu.test(text)) return 'Мотивация';
  if (index === 0) return 'Коротко о себе';
  return `Часть ${index + 1}`;
}

function stripHeading(text: string): string {
  const markdownHeading = text.match(/^#{1,4}\s+[^\n]+\n?/u)?.[0];
  if (markdownHeading) return text.slice(markdownHeading.length).replace(/^[-*•]\s+/u, '').trim();
  const [, ...rest] = text.split('\n');
  const withoutPlainHeading = getPlainHeading(text) ? rest.join('\n') : text;
  return withoutPlainHeading.replace(/^[-*•]\s+/u, '').trim();
}

function getPlainHeading(text: string): string | undefined {
  const [firstLine, ...rest] = text.split('\n');
  const candidate = firstLine.trim();
  if (!rest.length || !candidate || candidate.length > 70 || candidate.split(/\s+/u).length > 8) return undefined;
  if (/[.!?;,]$/u.test(candidate)) return undefined;
  return candidate;
}

function tokens(value: string): Set<string> {
  const result = new Set<string>();
  for (const raw of value.toLocaleLowerCase('ru-RU').match(/[\p{L}\p{N}+#./-]{3,}/gu) || []) {
    const token = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#./-]+$/gu, '');
    if (!token || STOP_WORDS.has(token)) continue;
    result.add(stem(token));
  }
  return result;
}

function stem(token: string): string {
  if (/^[a-z0-9+#./-]+$/u.test(token) || token.length < 7) return token;
  return token.slice(0, 6);
}

function weightedOverlap(left: Set<string>, right: Set<string>): number {
  let score = 0;
  for (const token of left) {
    if (!right.has(token)) continue;
    score += token.length >= 7 ? 2 : 1;
  }
  return score;
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function coverage(spoken: Set<string>, block: Set<string>): number {
  if (!block.size) return 0;
  return intersectionSize(spoken, block) / block.size;
}

function shortHash(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 8);
}
