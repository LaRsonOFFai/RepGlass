const askService = require('../../ask/askService');

const DEFAULT_DEBOUNCE_MS = 1800;
const DEFAULT_COOLDOWN_MS = 12000;
const DEFAULT_BUSY_RETRY_MS = 2500;
const MAX_BUSY_RETRIES = 3;

function parseEnvInt(name, fallback) {
    const value = Number.parseInt(process.env[name], 10);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

class AutoAnswerService {
    constructor(options = {}) {
        this.enabled = options.enabled ?? process.env.PICKLE_AUTO_ANSWER_ENABLED !== 'false';
        this.debounceMs = options.debounceMs ?? parseEnvInt('PICKLE_AUTO_ANSWER_DEBOUNCE_MS', DEFAULT_DEBOUNCE_MS);
        this.cooldownMs = options.cooldownMs ?? parseEnvInt('PICKLE_AUTO_ANSWER_COOLDOWN_MS', DEFAULT_COOLDOWN_MS);
        this.busyRetryMs = options.busyRetryMs ?? parseEnvInt('PICKLE_AUTO_ANSWER_BUSY_RETRY_MS', DEFAULT_BUSY_RETRY_MS);
        this.pendingTimer = null;
        this.pendingCandidate = null;
        this.lastAnsweredSignature = '';
        this.lastAnswerStartedAt = 0;
        this.onStatusUpdate = null;
    }

    setCallbacks({ onStatusUpdate } = {}) {
        this.onStatusUpdate = onStatusUpdate;
    }

    reset() {
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }

        this.pendingCandidate = null;
        this.lastAnsweredSignature = '';
        this.lastAnswerStartedAt = 0;
    }

    handleConversationTurn({ speaker, text, conversationHistory }) {
        if (!this.enabled || !text || !text.trim()) {
            return { queued: false, reason: 'disabled_or_empty' };
        }

        const candidate = this.extractQuestionCandidate(speaker, text);
        if (!candidate) {
            return { queued: false, reason: 'not_question' };
        }

        const signature = this.createSignature(candidate.question);
        if (!signature || signature.length < 10) {
            return { queued: false, reason: 'weak_signature' };
        }

        const now = Date.now();
        if (signature === this.lastAnsweredSignature && now - this.lastAnswerStartedAt < 60000) {
            return { queued: false, reason: 'duplicate' };
        }

        this.pendingCandidate = {
            ...candidate,
            signature,
            conversationHistory: Array.isArray(conversationHistory) ? [...conversationHistory] : [],
            retries: 0,
        };

        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
        }

        this.pendingTimer = setTimeout(() => {
            this.answerPendingQuestion().catch(error => {
                console.error('[AutoAnswerService] Auto-answer failed:', error);
            });
        }, this.debounceMs);

        this.emitStatus('Question detected. Preparing answer...');
        console.log(`[AutoAnswerService] Queued question from ${speaker}: ${candidate.question}`);
        return { queued: true, question: candidate.question };
    }

    extractQuestionCandidate(speaker, rawText) {
        const text = this.normalizeWhitespace(rawText);
        if (!text || this.isSuppressedSmallTalk(text)) {
            return null;
        }

        const sentence = this.pickMostRelevantQuestionSentence(text);
        if (!sentence || !this.looksLikeQuestion(sentence)) {
            return null;
        }

        return {
            speaker: speaker || 'Unknown',
            question: sentence,
        };
    }

    pickMostRelevantQuestionSentence(text) {
        const sentences = text
            .split(/(?<=[.?!])\s+/)
            .map(sentence => sentence.trim())
            .filter(Boolean);

        for (let index = sentences.length - 1; index >= 0; index -= 1) {
            if (this.looksLikeQuestion(sentences[index])) {
                return sentences[index];
            }
        }

        return text;
    }

    looksLikeQuestion(text) {
        const normalized = this.normalizeWhitespace(text).toLowerCase();
        if (!normalized) return false;

        if (normalized.includes('?')) return true;

        const russianQuestionStarters = [
            '\u0447\u0442\u043e', '\u043a\u0442\u043e', '\u043a\u043e\u0433\u0434\u0430', '\u0433\u0434\u0435', '\u043a\u0443\u0434\u0430', '\u043e\u0442\u043a\u0443\u0434\u0430',
            '\u043f\u043e\u0447\u0435\u043c\u0443', '\u0437\u0430\u0447\u0435\u043c', '\u043a\u0430\u043a', '\u043a\u0430\u043a\u043e\u0439', '\u043a\u0430\u043a\u0430\u044f',
            '\u043a\u0430\u043a\u0438\u0435', '\u043a\u0430\u043a\u043e\u0435', '\u0441\u043a\u043e\u043b\u044c\u043a\u043e', '\u043c\u043e\u0436\u0435\u0448\u044c',
            '\u043c\u043e\u0436\u0435\u0442\u0435', '\u043c\u043e\u0436\u043d\u043e', '\u0440\u0430\u0441\u0441\u043a\u0430\u0436\u0438',
            '\u0440\u0430\u0441\u0441\u043a\u0430\u0436\u0438\u0442\u0435', '\u043e\u0431\u044a\u044f\u0441\u043d\u0438',
            '\u043e\u0431\u044a\u044f\u0441\u043d\u0438\u0442\u0435', '\u043e\u043f\u0438\u0448\u0438', '\u043e\u043f\u0438\u0448\u0438\u0442\u0435',
        ];

        if (russianQuestionStarters.some(word => normalized.startsWith(`${word} `))) {
            return true;
        }

        const questionStarters = [
            'what', 'why', 'when', 'where', 'who', 'whom', 'whose', 'which', 'how',
            'can', 'could', 'would', 'will', 'should', 'do', 'does', 'did', 'are',
            'is', 'am', 'was', 'were', 'have', 'has', 'had',
            'что', 'кто', 'когда', 'где', 'куда', 'откуда', 'почему', 'зачем',
            'как', 'какой', 'какая', 'какие', 'какое', 'сколько', 'можешь',
            'можете', 'можно', 'расскажи', 'расскажите', 'объясни', 'объясните',
            'опиши', 'опишите',
        ];

        if (questionStarters.some(word => normalized.startsWith(`${word} `))) {
            return true;
        }

        const requestPatterns = [
            /\b(tell me|walk me through|explain|describe|clarify|give me|show me)\b/i,
            /\b(i am curious about|i'm curious about|i would love to hear|i'd love to hear)\b/i,
            /\b(what about|how about|and why|and how|scaling wise|performance wise)\b/i,
            /\b(расскажи|расскажите|объясни|объясните|опиши|опишите|покажи|покажите)\b/i,
        ];

        const russianRequestPattern = /(^|\s)(\u0440\u0430\u0441\u0441\u043a\u0430\u0436\u0438|\u0440\u0430\u0441\u0441\u043a\u0430\u0436\u0438\u0442\u0435|\u043e\u0431\u044a\u044f\u0441\u043d\u0438|\u043e\u0431\u044a\u044f\u0441\u043d\u0438\u0442\u0435|\u043e\u043f\u0438\u0448\u0438|\u043e\u043f\u0438\u0448\u0438\u0442\u0435|\u043f\u043e\u043a\u0430\u0436\u0438|\u043f\u043e\u043a\u0430\u0436\u0438\u0442\u0435)(\s|$)/i;

        return requestPatterns.some(pattern => pattern.test(text)) || russianRequestPattern.test(text);
    }

    isSuppressedSmallTalk(text) {
        const normalized = this.normalizeWhitespace(text).toLowerCase().replace(/[?.!]+$/, '');
        if (normalized.length > 48) return false;

        return [
            'how are you',
            'how are you doing',
            'can you hear me',
            'can you see my screen',
            'are you there',
            'are we good',
            'is this working',
            'you there',
        ].includes(normalized);
    }

    async answerPendingQuestion() {
        const candidate = this.pendingCandidate;
        this.pendingCandidate = null;
        this.pendingTimer = null;

        if (!candidate) return;

        await this.answerCandidate(candidate);
    }

    async answerLatestQuestionNow({ conversationHistory } = {}) {
        if (!this.enabled) {
            return { success: false, reason: 'disabled' };
        }

        let candidate = this.pendingCandidate;
        if (this.pendingTimer) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
        this.pendingCandidate = null;

        const history = Array.isArray(conversationHistory) ? [...conversationHistory] : [];
        if (!candidate) {
            candidate = this.extractLatestQuestionFromHistory(history);
        }

        if (!candidate) {
            return { success: false, reason: 'not_question' };
        }

        candidate.conversationHistory = history.length > 0
            ? history
            : Array.isArray(candidate.conversationHistory)
              ? candidate.conversationHistory
              : [];
        candidate.signature = candidate.signature || this.createSignature(candidate.question);
        candidate.retries = 0;

        const result = await this.answerCandidate(candidate, { ignoreCooldown: true });
        return { success: result.success, reason: result.reason, question: candidate.question };
    }

    async answerCandidate(candidate, { ignoreCooldown = false } = {}) {
        const now = Date.now();
        if (!ignoreCooldown && now - this.lastAnswerStartedAt < this.cooldownMs) {
            console.log('[AutoAnswerService] Skipping question because cooldown is active.');
            return { success: false, reason: 'cooldown' };
        }

        if (askService.isBusy?.() || askService.state?.isLoading || askService.state?.isStreaming) {
            if (candidate.retries < MAX_BUSY_RETRIES) {
                candidate.retries += 1;
                this.pendingCandidate = candidate;
                this.pendingTimer = setTimeout(() => {
                    this.answerPendingQuestion().catch(error => {
                        console.error('[AutoAnswerService] Busy retry failed:', error);
                    });
                }, this.busyRetryMs);
                console.log('[AutoAnswerService] Ask service busy, retrying auto-answer soon.');
            }
            return { success: false, reason: 'busy' };
        }

        this.lastAnswerStartedAt = now;
        this.lastAnsweredSignature = candidate.signature;
        this.emitStatus('Answering detected question...');

        const prompt = this.buildAutoAnswerPrompt(candidate);
        await askService.sendMessage(prompt, candidate.conversationHistory);
        return { success: true };
    }

    extractLatestQuestionFromHistory(conversationHistory) {
        if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
            return null;
        }

        for (let index = conversationHistory.length - 1; index >= 0; index -= 1) {
            const rawLine = String(conversationHistory[index] || '').trim();
            if (!rawLine) continue;

            const separatorIndex = rawLine.indexOf(':');
            const speaker = separatorIndex > -1 ? rawLine.slice(0, separatorIndex).trim() : 'Unknown';
            const text = separatorIndex > -1 ? rawLine.slice(separatorIndex + 1).trim() : rawLine;
            const candidate = this.extractQuestionCandidate(speaker, text);
            if (!candidate) continue;

            return {
                ...candidate,
                signature: this.createSignature(candidate.question),
                conversationHistory: [...conversationHistory],
                retries: 0,
            };
        }

        return null;
    }

    buildAutoAnswerPrompt(candidate) {
        return [
            `Auto-detected live question from ${candidate.speaker}:`,
            `"${candidate.question}"`,
            '',
            'Answer this question directly for the user.',
            'Use the recent transcript and the current screen as context.',
            'If the transcript is ambiguous, state the likely interpretation before answering.',
        ].join('\n');
    }

    createSignature(text) {
        return this.normalizeWhitespace(text)
            .toLowerCase()
            .replace(/[^a-z0-9а-яё]+/gi, ' ')
            .trim()
            .slice(0, 160);
    }

    normalizeWhitespace(text) {
        return String(text || '').replace(/\s+/g, ' ').trim();
    }

    emitStatus(status) {
        if (this.onStatusUpdate) {
            this.onStatusUpdate(status);
        }
    }
}

module.exports = AutoAnswerService;
