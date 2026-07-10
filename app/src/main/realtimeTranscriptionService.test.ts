import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { REALTIME_TRANSCRIPTION_URL, RealtimeTranscriptionService } from './realtimeTranscriptionService';

describe('realtime transcription protocol', () => {
  let server: WebSocketServer | undefined;
  let service: RealtimeTranscriptionService | undefined;

  afterEach(async () => {
    service?.stop(false);
    for (const client of server?.clients || []) client.terminate();
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it('opens a transcription session instead of treating the STT model as a realtime model', () => {
    const url = new URL(REALTIME_TRANSCRIPTION_URL);
    expect(url.searchParams.get('intent')).toBe('transcription');
    expect(url.searchParams.has('model')).toBe(false);
  });

  it('streams PCM24k audio and emits Russian partial and final text', async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const received: Array<Record<string, unknown>> = [];
    let peer: WebSocket | undefined;

    server.on('connection', (socket, request) => {
      peer = socket;
      expect(request.headers.authorization).toBe('Bearer test-key');
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(event);
        if (event.type === 'session.update') {
          socket.send(JSON.stringify({ type: 'transcription_session.updated' }));
        }
      });
    });

    const onPartial = vi.fn();
    const onFinal = vi.fn();
    const onError = vi.fn();
    service = new RealtimeTranscriptionService();
    await service.start({
      apiKey: 'test-key',
      endpoint: `ws://127.0.0.1:${port}`,
      language: 'ru',
      delay: 'minimal',
      callbacks: { onPartial, onFinal, onError, onClose: vi.fn() },
    });

    service.appendAudio({ base64: 'AQIDBA==', sampleRate: 24_000 });
    service.commit();
    await vi.waitFor(() => expect(received).toHaveLength(3));

    peer?.send(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'question-1',
        delta: 'Как сделать ',
      }),
    );
    peer?.send(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'question-1',
        delta: 'попкорн?',
      }),
    );
    peer?.send(
      JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'question-1',
        transcript: 'Как сделать попкорн?',
      }),
    );

    await vi.waitFor(() => expect(onFinal).toHaveBeenCalledWith('question-1', 'Как сделать попкорн?'));
    expect(onPartial).toHaveBeenLastCalledWith('question-1', 'Как сделать попкорн?');
    expect(onError).not.toHaveBeenCalled();

    const sessionUpdate = received[0] as {
      session: {
        audio: {
          input: {
            format: { type: string; rate: number };
            transcription: { model: string; language: string; delay: string };
            turn_detection: null;
          };
        };
      };
    };
    expect(sessionUpdate.session.audio.input).toEqual({
      format: { type: 'audio/pcm', rate: 24_000 },
      transcription: {
        model: 'gpt-realtime-whisper',
        language: 'ru',
        delay: 'minimal',
      },
      turn_detection: null,
    });
    expect(received[1]).toEqual({ type: 'input_audio_buffer.append', audio: 'AQIDBA==' });
    expect(received[2]).toEqual({ type: 'input_audio_buffer.commit' });
  });

  it('rejects audio with an unexpected sample rate before sending it', async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server?.once('listening', resolve));
    const port = (server.address() as AddressInfo).port;
    const received: Array<Record<string, unknown>> = [];

    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>;
        received.push(event);
        if (event.type === 'session.update') socket.send(JSON.stringify({ type: 'session.updated' }));
      });
    });

    const onError = vi.fn();
    service = new RealtimeTranscriptionService();
    await service.start({
      apiKey: 'test-key',
      endpoint: `ws://127.0.0.1:${port}`,
      callbacks: { onPartial: vi.fn(), onFinal: vi.fn(), onError, onClose: vi.fn() },
    });

    service.appendAudio({ base64: 'AQIDBA==', sampleRate: 48_000 });
    expect(onError).toHaveBeenCalledWith('Unsupported audio rate: 48000 Hz');
    expect(received).toHaveLength(1);
  });
});
