let spawn, path, fs, EventEmitter;

if (typeof window === 'undefined') {
    spawn = require('child_process').spawn;
    path = require('path');
    fs = require('fs');
    EventEmitter = require('events').EventEmitter;
} else {
    class DummyEventEmitter {
        on() {}
        emit() {}
        removeAllListeners() {}
    }
    EventEmitter = DummyEventEmitter;
}

class WhisperSTTSession extends EventEmitter {
    constructor(model, whisperService, sessionId) {
        super();
        this.model = model;
        this.whisperService = whisperService;
        this.sessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        this.process = null;
        this.isRunning = false;
        this.audioBuffer = Buffer.alloc(0);
        this.processingInterval = null;
        this.lastTranscription = '';
        this.sampleRate = 24000;
    }

    async initialize() {
        try {
            await this.whisperService.ensureModelAvailable(this.model);
            this.isRunning = true;
            this.startProcessingLoop();
            return true;
        } catch (error) {
            console.error('[WhisperSTT] Initialization error:', error);
            this.emit('error', error);
            return false;
        }
    }

    startProcessingLoop() {
        this.processingInterval = setInterval(async () => {
            const minBufferSize = this.sampleRate * 2 * 4;
            if (this.audioBuffer.length >= minBufferSize && !this.process) {
                console.log(`[WhisperSTT-${this.sessionId}] Processing audio chunk, buffer size: ${this.audioBuffer.length}`);
                await this.processAudioChunk();
            }
        }, 1500);
    }

    extractTextFromWhisperJson(parsed) {
        const readText = item => {
            if (!item) return '';
            if (typeof item === 'string') return item;
            if (typeof item.text === 'string') return item.text;
            if (typeof item.transcript === 'string') return item.transcript;
            if (typeof item.result === 'string') return item.result;
            return '';
        };

        const directText = readText(parsed);
        if (directText.trim()) return directText.trim();

        const arrays = [parsed.transcription, parsed.segments, parsed.results];
        for (const value of arrays) {
            if (!Array.isArray(value)) continue;
            const text = value.map(readText).filter(Boolean).join(' ').trim();
            if (text) return text;
        }

        return '';
    }

    async readWhisperOutput(tempFile, stdout) {
        const stdoutText = String(stdout || '').trim();
        if (stdoutText) return stdoutText;
        if (!fs) return '';

        const basePath = tempFile.replace(/\.[^.\\/]+$/, '');
        const candidates = [
            `${tempFile}.txt`,
            `${basePath}.txt`,
            `${tempFile}.json`,
            `${basePath}.json`,
        ];

        for (const candidate of candidates) {
            try {
                if (!fs.existsSync(candidate)) continue;
                const raw = await fs.promises.readFile(candidate, 'utf8');
                const trimmed = raw.trim();
                if (!trimmed) continue;

                if (candidate.endsWith('.json')) {
                    try {
                        const parsed = JSON.parse(trimmed);
                        const text = this.extractTextFromWhisperJson(parsed);
                        if (text) return text;
                    } catch (_) {}
                } else {
                    return trimmed;
                }
            } catch (error) {
                console.warn(`[WhisperSTT-${this.sessionId}] Failed to read output ${candidate}:`, error.message);
            }
        }

        return '';
    }

    async cleanupWhisperOutputs(tempFile) {
        if (!fs) return;

        const basePath = tempFile.replace(/\.[^.\\/]+$/, '');
        const candidates = [
            `${tempFile}.txt`,
            `${basePath}.txt`,
            `${tempFile}.json`,
            `${basePath}.json`,
        ];

        await Promise.all(candidates.map(async candidate => {
            try {
                if (fs.existsSync(candidate)) {
                    await fs.promises.unlink(candidate);
                }
            } catch (_) {}
        }));
    }

    async processAudioChunk() {
        if (!this.isRunning || this.audioBuffer.length === 0) return;

        const audioData = this.audioBuffer;
        this.audioBuffer = Buffer.alloc(0);

        try {
            const tempFile = await this.whisperService.saveAudioToTemp(audioData, this.sessionId, this.sampleRate);
            
            if (!tempFile || typeof tempFile !== 'string') {
                console.error('[WhisperSTT] Invalid temp file path:', tempFile);
                return;
            }
            
            const whisperPath = await this.whisperService.getWhisperPath();
            const modelPath = await this.whisperService.getModelPath(this.model);

            if (!whisperPath || !modelPath) {
                console.error('[WhisperSTT] Invalid whisper or model path:', { whisperPath, modelPath });
                return;
            }

            this.process = spawn(whisperPath, [
                '-m', modelPath,
                '-f', tempFile,
                '--no-timestamps',
                '--output-txt',
                '--output-json',
                '--language', 'auto',
                '--threads', '4',
                '--no-prints'
            ]);

            let output = '';
            let errorOutput = '';

            this.process.stdout.on('data', (data) => {
                output += data.toString();
            });

            this.process.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            this.process.on('close', async (code) => {
                this.process = null;

                const transcription = code === 0
                    ? await this.readWhisperOutput(tempFile, output)
                    : '';

                if (code === 0 && transcription) {
                    if (transcription && transcription !== this.lastTranscription) {
                        this.lastTranscription = transcription;
                        console.log(`[WhisperSTT-${this.sessionId}] Transcription: "${transcription}"`);
                        this.emit('transcription', {
                            text: transcription,
                            timestamp: Date.now(),
                            confidence: 1.0,
                            sessionId: this.sessionId
                        });
                    }
                } else if (code === 0) {
                    console.log(`[WhisperSTT-${this.sessionId}] No transcription produced for chunk (${audioData.length} bytes at ${this.sampleRate} Hz).`);
                    if (errorOutput.trim()) {
                        console.log(`[WhisperSTT-${this.sessionId}] Whisper stderr: ${errorOutput.trim().slice(-1000)}`);
                    }
                } else if (!this.isRunning && code === null) {
                    console.log(`[WhisperSTT-${this.sessionId}] Whisper process stopped during session shutdown.`);
                } else {
                    console.error(`[WhisperSTT-${this.sessionId}] Process exited with code ${code || 'unknown'} while processing ${audioData.length} bytes at ${this.sampleRate} Hz.`);
                    if (errorOutput.trim()) {
                        console.error(`[WhisperSTT-${this.sessionId}] Process error:`, errorOutput.trim().slice(-2000));
                    }
                }

                await this.cleanupWhisperOutputs(tempFile);
                await this.whisperService.cleanupTempFile(tempFile);
            });

        } catch (error) {
            console.error('[WhisperSTT] Processing error:', error);
            this.emit('error', error);
        }
    }

    parseSampleRate(mimeType) {
        const match = String(mimeType || '').match(/rate=(\d+)/i);
        return match ? Number(match[1]) : null;
    }

    sendRealtimeInput(audioData) {
        if (!this.isRunning) {
            console.warn(`[WhisperSTT-${this.sessionId}] Session not running, cannot accept audio`);
            return;
        }

        if (audioData && typeof audioData === 'object' && !Buffer.isBuffer(audioData) && !(audioData instanceof ArrayBuffer) && !(audioData instanceof Uint8Array)) {
            const rate = this.parseSampleRate(audioData.mimeType);
            if (rate) this.sampleRate = rate;
            audioData = audioData.data;
        }

        if (typeof audioData === 'string') {
            try {
                audioData = Buffer.from(audioData, 'base64');
            } catch (error) {
                console.error('[WhisperSTT] Failed to decode base64 audio data:', error);
                return;
            }
        } else if (audioData instanceof ArrayBuffer) {
            audioData = Buffer.from(audioData);
        } else if (!Buffer.isBuffer(audioData) && !(audioData instanceof Uint8Array)) {
            console.error('[WhisperSTT] Invalid audio data type:', typeof audioData);
            return;
        }

        if (!Buffer.isBuffer(audioData)) {
            audioData = Buffer.from(audioData);
        }

        if (audioData.length > 0) {
            this.audioBuffer = Buffer.concat([this.audioBuffer, audioData]);
            // Log every 10th audio chunk to avoid spam
            if (Math.random() < 0.1) {
                console.log(`[WhisperSTT-${this.sessionId}] Received audio chunk: ${audioData.length} bytes, total buffer: ${this.audioBuffer.length} bytes`);
            }
        }
    }

    async close() {
        console.log(`[WhisperSTT-${this.sessionId}] Closing session`);
        this.isRunning = false;

        if (this.processingInterval) {
            clearInterval(this.processingInterval);
            this.processingInterval = null;
        }

        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }

        this.removeAllListeners();
    }
}

class WhisperProvider {
    static async validateApiKey() {
        // Whisper is a local service, no API key validation needed.
        return { success: true };
    }

    constructor() {
        this.whisperService = null;
    }

    async initialize() {
        if (!this.whisperService) {
            this.whisperService = require('../../services/whisperService');
            if (!this.whisperService.isInitialized) {
                await this.whisperService.initialize();
            }
        }
    }

    async createSTT(config) {
        await this.initialize();
        
        const model = config.model || 'whisper-tiny';
        const sessionType = config.sessionType || 'unknown';
        console.log(`[WhisperProvider] Creating ${sessionType} STT session with model: ${model}`);
        
        // Create unique session ID based on type
        const sessionId = `${sessionType}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const session = new WhisperSTTSession(model, this.whisperService, sessionId);
        
        // Log session creation
        console.log(`[WhisperProvider] Created session: ${sessionId}`);
        
        const initialized = await session.initialize();
        if (!initialized) {
            throw new Error('Failed to initialize Whisper STT session');
        }

        if (config.callbacks) {
            if (config.callbacks.onmessage) {
                session.on('transcription', config.callbacks.onmessage);
            }
            if (config.callbacks.onerror) {
                session.on('error', config.callbacks.onerror);
            }
            if (config.callbacks.onclose) {
                session.on('close', config.callbacks.onclose);
            }
        }

        return session;
    }

    async createLLM() {
        throw new Error('Whisper provider does not support LLM functionality');
    }

    async createStreamingLLM() {
        console.warn('[WhisperProvider] Streaming LLM is not supported by Whisper.');
        throw new Error('Whisper does not support LLM.');
    }
}

module.exports = {
    WhisperProvider,
    WhisperSTTSession
};
