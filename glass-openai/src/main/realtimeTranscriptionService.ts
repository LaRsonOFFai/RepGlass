import WebSocket from 'ws';
import type { AudioChunkPayload } from './types';

type RealtimeTranscriptionCallbacks = {
  onPartial: (itemId: string, text: string) => void;
  onFinal: (itemId: string, text: string) => void;
  onError: (message: string) => void;
  onClose: () => void;
};

type StartParams = {
  apiKey: string;
  language?: string;
  callbacks: RealtimeTranscriptionCallbacks;
};

type RealtimeEvent = {
  type?: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: { message?: string };
};

const REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-whisper';

export class RealtimeTranscriptionService {
  private socket: WebSocket | null = null;
  private callbacks: RealtimeTranscriptionCallbacks | null = null;
  private readonly partials = new Map<string, string>();
  private hasBufferedAudio = false;
  private closing = false;
  private closeTimer: NodeJS.Timeout | null = null;

  async start(params: StartParams): Promise<void> {
    this.closeNow();
    this.callbacks = params.callbacks;
    this.closing = false;

    const socket = new WebSocket(REALTIME_URL, {
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
      },
    });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Realtime transcription connection timed out'));
        socket.close();
      }, 15_000);

      socket.once('open', () => {
        clearTimeout(timeout);
        socket.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              type: 'transcription',
              audio: {
                input: {
                  format: { type: 'audio/pcm', rate: 24_000 },
                  transcription: {
                    model: 'gpt-realtime-whisper',
                    language: params.language || undefined,
                    delay: 'low',
                  },
                  turn_detection: null,
                },
              },
            },
          }),
        );
        resolve();
      });

      socket.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    socket.on('message', (data) => this.handleMessage(data.toString()));
    socket.on('error', (error) => this.callbacks?.onError(error.message));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      const wasUnexpected = !this.closing;
      this.socket = null;
      this.hasBufferedAudio = false;
      this.partials.clear();
      if (wasUnexpected) this.callbacks?.onClose();
    });
  }

  appendAudio(payload: AudioChunkPayload): void {
    if (payload.sampleRate !== 24_000) {
      this.callbacks?.onError(`Unsupported audio rate: ${payload.sampleRate} Hz`);
      return;
    }
    if (!this.isOpen()) return;

    this.socket?.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: payload.base64,
      }),
    );
    this.hasBufferedAudio = true;
  }

  commit(): void {
    if (!this.isOpen() || !this.hasBufferedAudio) return;
    this.socket?.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    this.hasBufferedAudio = false;
  }

  stop(flush = true): void {
    if (!this.socket) return;
    this.closing = true;

    if (flush && this.hasBufferedAudio) {
      this.commit();
      this.closeTimer = setTimeout(() => this.closeNow(), 1_500);
      return;
    }

    this.closeNow();
  }

  private handleMessage(raw: string): void {
    let event: RealtimeEvent;
    try {
      event = JSON.parse(raw) as RealtimeEvent;
    } catch {
      return;
    }

    if (event.type === 'conversation.item.input_audio_transcription.delta') {
      const itemId = event.item_id || 'live';
      const text = `${this.partials.get(itemId) || ''}${event.delta || ''}`;
      this.partials.set(itemId, text);
      this.callbacks?.onPartial(itemId, text.trim());
      return;
    }

    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const itemId = event.item_id || 'live';
      const text = (event.transcript || this.partials.get(itemId) || '').trim();
      this.partials.delete(itemId);
      if (text) this.callbacks?.onFinal(itemId, text);
      return;
    }

    if (event.type === 'error') {
      this.callbacks?.onError(event.error?.message || 'Realtime transcription error');
    }
  }

  private isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private closeNow(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.socket) {
      this.closing = true;
      this.socket.close();
      this.socket = null;
    }
    this.hasBufferedAudio = false;
    this.partials.clear();
  }
}
