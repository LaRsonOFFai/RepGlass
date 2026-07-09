const OpenAI = require('openai');
const WebSocket = require('ws');
const { Readable } = require('stream');
const { ReadableStream } = require('stream/web');
const { TextDecoder, TextEncoder } = require('util');
const { getProviderForModel } = require('../factory.js');

const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';
const REALTIME_TRANSCRIPTION_COMMIT_BYTES = 24000 * 2;
const REALTIME_TRANSCRIPTION_COMMIT_MS = 1000;

function normalizeRealtimeTranscriptionModel(model) {
  const normalized = typeof model === 'string' ? model.replace(/-glass$/, '') : '';
  return normalized && normalized.startsWith('gpt-realtime-whisper')
    ? normalized
    : DEFAULT_REALTIME_TRANSCRIPTION_MODEL;
}

function normalizeLanguage(language) {
  if (!language || typeof language !== 'string') return 'en';
  return language.includes('-') ? language.split('-')[0] : language;
}

function shouldUseResponsesApi(model) {
  return typeof model === 'string' && /^gpt-5(?:[.-]|$)/.test(model);
}

function getDefaultReasoningEffort(model) {
  if (typeof model !== 'string' || !shouldUseResponsesApi(model)) return undefined;
  if (model.includes('nano') || model.includes('mini')) return 'low';
  return 'medium';
}

function getDefaultVerbosity(model) {
  return shouldUseResponsesApi(model) ? 'low' : undefined;
}

function buildProviderHeaders({ apiKey, usePortkey = false, portkeyVirtualKey }) {
  return usePortkey
    ? {
        'x-portkey-api-key': 'gRv2UGRMq6GGLJ8aVEB4e7adIewu',
        'x-portkey-virtual-key': portkeyVirtualKey || apiKey,
        'Content-Type': 'application/json',
      }
    : {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      };
}

function toResponsesRole(role) {
  if (role === 'system') return 'developer';
  if (role === 'assistant') return 'assistant';
  return 'user';
}

function toResponsesContent(content) {
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }];
  }

  if (!Array.isArray(content)) {
    return [{ type: 'input_text', text: String(content || '') }];
  }

  return content
    .map(part => {
      if (part?.type === 'text') {
        return { type: 'input_text', text: part.text || '' };
      }
      if (part?.type === 'image_url' && part.image_url?.url) {
        return { type: 'input_image', image_url: part.image_url.url };
      }
      return null;
    })
    .filter(Boolean);
}

function toResponsesInput(messages) {
  return (messages || []).map(message => ({
    role: toResponsesRole(message.role),
    content: toResponsesContent(message.content),
  }));
}

function extractResponsesText(result) {
  if (typeof result?.output_text === 'string') {
    return result.output_text;
  }

  const chunks = [];
  for (const item of result?.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join('');
}

async function readErrorMessage(response, fallbackPrefix) {
  const text = await response.text().catch(() => '');
  try {
    const data = JSON.parse(text);
    return data.error?.message || `${fallbackPrefix}: ${response.status} ${response.statusText}`;
  } catch {
    return text || `${fallbackPrefix}: ${response.status} ${response.statusText}`;
  }
}

function buildResponsesBody({ model, messages, maxTokens, stream, config = {} }) {
  const body = {
    model,
    input: toResponsesInput(messages),
    max_output_tokens: maxTokens,
    stream,
  };

  const effort = config.reasoningEffort || config.reasoning?.effort || getDefaultReasoningEffort(model);
  if (effort) {
    body.reasoning = { effort };
  }

  const verbosity = config.verbosity || getDefaultVerbosity(model);
  if (verbosity) {
    body.text = { verbosity };
  }

  return body;
}

async function callResponsesApi({ apiKey, model, messages, maxTokens, usePortkey, portkeyVirtualKey, config }) {
  const response = await fetch(usePortkey ? 'https://api.portkey.ai/v1/responses' : 'https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: buildProviderHeaders({ apiKey, usePortkey, portkeyVirtualKey }),
    body: JSON.stringify(buildResponsesBody({ model, messages, maxTokens, stream: false, config })),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'OpenAI Responses API error'));
  }

  const result = await response.json();
  return {
    content: extractResponsesText(result).trim(),
    raw: result,
  };
}

function responsesStreamToChatSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffer = '';
  let sentDone = false;

  const encodeChatDelta = text => encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  const encodeDone = () => encoder.encode('data: [DONE]\n\n');

  function handleBlock(block, controller) {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');

    if (!data || data === '[DONE]') return;

    const event = JSON.parse(data);
    if (event.type === 'response.output_text.delta' && event.delta) {
      controller.enqueue(encodeChatDelta(event.delta));
      return;
    }

    if (event.type === 'response.failed' || event.type === 'error') {
      const message = event.error?.message || event.response?.error?.message || 'OpenAI Responses stream failed';
      throw new Error(message);
    }

    if (event.type === 'response.completed' && !sentDone) {
      sentDone = true;
      controller.enqueue(encodeDone());
    }
  }

  const body = new ReadableStream({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || '';

          for (const block of blocks) {
            handleBlock(block, controller);
          }
        }

        if (buffer.trim()) {
          handleBlock(buffer, controller);
        }

        if (!sentDone) {
          controller.enqueue(encodeDone());
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return { body };
}

async function callResponsesStreamingApi({ apiKey, model, messages, maxTokens, usePortkey, portkeyVirtualKey, config }) {
  const response = await fetch(usePortkey ? 'https://api.portkey.ai/v1/responses' : 'https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: buildProviderHeaders({ apiKey, usePortkey, portkeyVirtualKey }),
    body: JSON.stringify(buildResponsesBody({ model, messages, maxTokens, stream: true, config })),
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, 'OpenAI Responses API error'));
  }

  return responsesStreamToChatSse(response);
}

class OpenAIProvider {
    static async validateApiKey(key) {
        if (!key || typeof key !== 'string' || !key.startsWith('sk-')) {
            return { success: false, error: 'Invalid OpenAI API key format.' };
        }

        try {
            const response = await fetch('https://api.openai.com/v1/models', {
                headers: { 'Authorization': `Bearer ${key}` }
            });

            if (response.ok) {
                return { success: true };
            } else {
                const errorData = await response.json().catch(() => ({}));
                const message = errorData.error?.message || `Validation failed with status: ${response.status}`;
                return { success: false, error: message };
            }
        } catch (error) {
            console.error(`[OpenAIProvider] Network error during key validation:`, error);
            return { success: false, error: 'A network error occurred during validation.' };
        }
    }
}


/**
 * Creates an OpenAI STT session
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - OpenAI API key
 * @param {string} [opts.language='en'] - Language code
 * @param {object} [opts.callbacks] - Event callbacks
 * @param {boolean} [opts.usePortkey=false] - Whether to use Portkey
 * @param {string} [opts.portkeyVirtualKey] - Portkey virtual key
 * @returns {Promise<object>} STT session
 */
async function createSTT({
  apiKey,
  model = DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
  language = 'en',
  callbacks = {},
  usePortkey = false,
  portkeyVirtualKey,
  ...config
}) {
  const keyType = usePortkey ? 'vKey' : 'apiKey';
  const key = usePortkey ? (portkeyVirtualKey || apiKey) : apiKey;
  const realtimeModel = normalizeRealtimeTranscriptionModel(model);
  const realtimeLanguage = normalizeLanguage(language);
  const sessionLabel = config.sessionType || 'unknown';

  const wsUrl = keyType === 'apiKey'
    ? 'wss://api.openai.com/v1/realtime?intent=transcription'
    : 'wss://api.portkey.ai/v1/realtime?intent=transcription';

  const headers = keyType === 'apiKey'
    ? {
        'Authorization': `Bearer ${key}`,
      }
    : {
        'x-portkey-api-key': 'gRv2UGRMq6GGLJ8aVEB4e7adIewu',
        'x-portkey-virtual-key': key,
      };

  const ws = new WebSocket(wsUrl, { headers });
  let pendingAudioBytes = 0;
  let commitTimer = null;
  let audioChunkCount = 0;
  let lastAudioLogAt = 0;

  const estimatePcmBytes = audioData => {
    if (typeof audioData !== 'string') return 0;
    const padding = audioData.endsWith('==') ? 2 : audioData.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((audioData.length * 3) / 4) - padding);
  };

  const commitAudio = () => {
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }
    if (ws.readyState !== WebSocket.OPEN || pendingAudioBytes <= 0) return;

    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    pendingAudioBytes = 0;
  };

  const scheduleCommit = () => {
    if (pendingAudioBytes >= REALTIME_TRANSCRIPTION_COMMIT_BYTES) {
      commitAudio();
      return;
    }
    if (!commitTimer) {
      commitTimer = setTimeout(commitAudio, REALTIME_TRANSCRIPTION_COMMIT_MS);
    }
  };

  return new Promise((resolve, reject) => {
    let resolved = false;
    let sessionReadyTimeout = null;
    let sttSession = null;

    const clearSessionReadyTimeout = () => {
      if (sessionReadyTimeout) {
        clearTimeout(sessionReadyTimeout);
        sessionReadyTimeout = null;
      }
    };

    const resolveSession = () => {
      clearSessionReadyTimeout();
      if (!resolved) {
        resolved = true;
        resolve(sttSession);
      }
    };

    const rejectSession = error => {
      clearSessionReadyTimeout();
      if (!resolved) {
        resolved = true;
        reject(error);
      }
    };

    ws.onopen = () => {
      console.log(`[OpenAI STT:${sessionLabel}] Realtime transcription WebSocket opened with ${realtimeModel}.`);

      const sessionConfig = {
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: {
                type: 'audio/pcm',
                rate: 24000,
              },
              transcription: {
                model: realtimeModel,
                language: realtimeLanguage,
                delay: config.delay || 'low',
              },
            },
          }
        }
      };

      // Helper to periodically keep the websocket alive
      const keepAlive = () => {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            // The ws library supports native ping frames which are ideal for heart-beats
            ws.ping();
          }
        } catch (err) {
          console.error('[OpenAI STT] keepAlive error:', err.message);
        }
      };

      sttSession = {
        sendRealtimeInput: (audioData) => {
          if (ws.readyState === WebSocket.OPEN) {
            const message = {
              type: 'input_audio_buffer.append',
              audio: audioData
            };
            ws.send(JSON.stringify(message));
            pendingAudioBytes += estimatePcmBytes(audioData);
            audioChunkCount += 1;
            const now = Date.now();
            if (audioChunkCount === 1 || now - lastAudioLogAt > 5000) {
              lastAudioLogAt = now;
              console.log(`[OpenAI STT:${sessionLabel}] Sent audio chunk #${audioChunkCount} (${pendingAudioBytes} pending PCM bytes).`);
            }
            scheduleCommit();
          }
        },
        // Expose keepAlive so higher-level services can schedule heart-beats
        keepAlive,
        close: () => {
          commitAudio();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'session.close' }));
            ws.onmessage = ws.onerror = () => {};  // 핸들러 제거
            ws.close(1000, 'Client initiated close.');
          }
        }
      };

      ws.send(JSON.stringify(sessionConfig));
      sessionReadyTimeout = setTimeout(() => {
        rejectSession(new Error('OpenAI Realtime STT session did not become ready.'));
      }, 10000);
    };

    ws.onmessage = (event) => {
      // ── 종료·하트비트 패킷 필터링 ──────────────────────────────
      if (!event.data || event.data === 'null' || event.data === '[DONE]') return;

      let msg;
      try { msg = JSON.parse(event.data); }
      catch { return; }                       // JSON 파싱 실패 무시

      if (!msg || typeof msg !== 'object') return;

      msg.provider = 'openai';                // ← 항상 명시
      if (msg.type === 'error' && msg.error) {
        const error = new Error(msg.error.message || 'OpenAI Realtime STT error');
        error.code = msg.error.code;
        error.raw = msg.error;
        callbacks.onerror?.(error);
        rejectSession(error);
      }
      if ((msg.type === 'session.updated' || msg.type === 'transcription_session.updated') && sttSession) {
        resolveSession();
      }
      callbacks.onmessage?.(msg);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error.message);
      if (callbacks && callbacks.onerror) {
        callbacks.onerror(error);
      }
      rejectSession(error);
    };

    ws.onclose = (event) => {
      if (commitTimer) {
        clearTimeout(commitTimer);
        commitTimer = null;
      }
      console.log(`WebSocket closed: ${event.code} ${event.reason}`);
      if (!resolved) {
        rejectSession(new Error(`OpenAI Realtime STT socket closed before ready: ${event.code} ${event.reason}`));
      }
      if (callbacks && callbacks.onclose) {
        callbacks.onclose(event);
      }
    };
  });
}

/**
 * Creates an OpenAI LLM instance
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - OpenAI API key
 * @param {string} [opts.model='gpt-4.1'] - Model name
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {number} [opts.maxTokens=2048] - Max tokens
 * @param {boolean} [opts.usePortkey=false] - Whether to use Portkey
 * @param {string} [opts.portkeyVirtualKey] - Portkey virtual key
 * @returns {object} LLM instance
 */
function createLLM({ apiKey, model = 'gpt-4.1', temperature = 0.7, maxTokens = 2048, usePortkey = false, portkeyVirtualKey, ...config }) {
  const client = new OpenAI({ apiKey });

  const callApi = async (messages) => {
    if (shouldUseResponsesApi(model)) {
      return await callResponsesApi({
        apiKey,
        model,
        messages,
        maxTokens,
        usePortkey,
        portkeyVirtualKey,
        config,
      });
    }

    if (!usePortkey) {
      const response = await client.chat.completions.create({
        model: model,
        messages: messages,
        temperature: temperature,
        max_tokens: maxTokens
      });
      return {
        content: response.choices[0].message.content.trim(),
        raw: response
      };
    } else {
      const fetchUrl = 'https://api.portkey.ai/v1/chat/completions';
      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers: {
            'x-portkey-api-key': 'gRv2UGRMq6GGLJ8aVEB4e7adIewu',
            'x-portkey-virtual-key': portkeyVirtualKey || apiKey,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: model,
            messages,
            temperature,
            max_tokens: maxTokens,
        }),
      });

      if (!response.ok) {
        throw new Error(`Portkey API error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();
      return {
        content: result.choices[0].message.content.trim(),
        raw: result
      };
    }
  };

  return {
    generateContent: async (parts) => {
      const messages = [];
      let systemPrompt = '';
      let userContent = [];

      for (const part of parts) {
        if (typeof part === 'string') {
          if (systemPrompt === '' && part.includes('You are')) {
            systemPrompt = part;
          } else {
            userContent.push({ type: 'text', text: part });
          }
        } else if (part.inlineData) {
          userContent.push({
            type: 'image_url',
            image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` }
          });
        }
      }

      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      if (userContent.length > 0) messages.push({ role: 'user', content: userContent });

      const result = await callApi(messages);

      return {
        response: {
          text: () => result.content
        },
        raw: result.raw
      };
    },

    // For compatibility with chat-style interfaces
    chat: async (messages) => {
      return await callApi(messages);
    }
  };
}

/**
 * Creates an OpenAI streaming LLM instance
 * @param {object} opts - Configuration options
 * @param {string} opts.apiKey - OpenAI API key
 * @param {string} [opts.model='gpt-4.1'] - Model name
 * @param {number} [opts.temperature=0.7] - Temperature
 * @param {number} [opts.maxTokens=2048] - Max tokens
 * @param {boolean} [opts.usePortkey=false] - Whether to use Portkey
 * @param {string} [opts.portkeyVirtualKey] - Portkey virtual key
 * @returns {object} Streaming LLM instance
 */
function createStreamingLLM({ apiKey, model = 'gpt-4.1', temperature = 0.7, maxTokens = 2048, usePortkey = false, portkeyVirtualKey, ...config }) {
  return {
    streamChat: async (messages) => {
      if (shouldUseResponsesApi(model)) {
        return await callResponsesStreamingApi({
          apiKey,
          model,
          messages,
          maxTokens,
          usePortkey,
          portkeyVirtualKey,
          config,
        });
      }

      const fetchUrl = usePortkey
        ? 'https://api.portkey.ai/v1/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';

      const headers = usePortkey
        ? {
            'x-portkey-api-key': 'gRv2UGRMq6GGLJ8aVEB4e7adIewu',
            'x-portkey-virtual-key': portkeyVirtualKey || apiKey,
            'Content-Type': 'application/json',
          }
        : {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          };

      const response = await fetch(fetchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
      }

      return response;
    }
  };
}

module.exports = {
    OpenAIProvider,
    createSTT,
    createLLM,
    createStreamingLLM
};
