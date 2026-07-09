const { ReadableStream } = require('stream/web');
const { TextEncoder } = require('util');
const codexAuthService = require('../../services/codexAuthService');

class CodexProvider {
    static async validateApiKey() {
        const status = await codexAuthService.getStatus();
        if (!status.available) {
            return { success: false, error: status.error || 'Codex CLI is not available.' };
        }
        if (!status.loggedIn) {
            return { success: false, error: 'OpenAI Codex is not logged in.' };
        }
        return { success: true };
    }
}

function extractPromptAndImages(messages) {
    const promptParts = [
        'You are running inside RepGlass, a live translucent desktop assistant.',
        'Answer concisely and directly for the user. Use any attached screenshot as visual context.',
        '',
    ];
    const images = [];

    for (const message of messages || []) {
        const role = String(message.role || 'user').toUpperCase();
        const content = message.content;

        if (typeof content === 'string') {
            promptParts.push(`[${role}]`, content, '');
            continue;
        }

        if (Array.isArray(content)) {
            promptParts.push(`[${role}]`);
            for (const part of content) {
                if (part?.type === 'text' && part.text) {
                    promptParts.push(part.text);
                } else if (part?.type === 'image_url' && part.image_url?.url) {
                    const match = String(part.image_url.url).match(/^data:([^;]+);base64,(.+)$/);
                    if (match) {
                        images.push({ mimeType: match[1], data: match[2] });
                        promptParts.push('[Attached screenshot]');
                    }
                }
            }
            promptParts.push('');
        }
    }

    return { prompt: promptParts.join('\n').trim(), images };
}

function createSseResponse(text) {
    const encoder = new TextEncoder();
    const chunks = String(text || '').match(/[\s\S]{1,600}/g) || [''];

    const body = new ReadableStream({
        start(controller) {
            for (const chunk of chunks) {
                const payload = {
                    choices: [
                        {
                            delta: {
                                content: chunk,
                            },
                        },
                    ],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        },
    });

    return { body };
}

function createLLM({ model = 'gpt-5.5' } = {}) {
    return {
        generateContent: async parts => {
            const prompt = Array.isArray(parts)
                ? parts.map(part => (typeof part === 'string' ? part : '')).filter(Boolean).join('\n\n')
                : String(parts || '');

            const answer = await codexAuthService.runPrompt({ prompt, model });
            return {
                response: {
                    text: () => answer,
                },
                raw: { provider: 'codex', model },
            };
        },
        chat: async messages => {
            const { prompt, images } = extractPromptAndImages(messages);
            const content = await codexAuthService.runPrompt({ prompt, model, images });
            return { content, raw: { provider: 'codex', model } };
        },
    };
}

function createStreamingLLM({ model = 'gpt-5.5' } = {}) {
    return {
        streamChat: async messages => {
            const { prompt, images } = extractPromptAndImages(messages);
            const answer = await codexAuthService.runPrompt({ prompt, model, images });
            return createSseResponse(answer);
        },
    };
}

module.exports = {
    CodexProvider,
    createLLM,
    createStreamingLLM,
};
