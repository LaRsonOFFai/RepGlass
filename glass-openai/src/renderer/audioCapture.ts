import type { AppSettings, AudioChunkPayload } from '../main/types';

type ChunkHandler = (payload: AudioChunkPayload) => void | Promise<void>;

export class AudioCapture {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;

  async start(settings: AppSettings, onChunk: ChunkHandler): Promise<void> {
    if (this.recorder?.state === 'recording') return;

    this.stream = await this.createStream(settings.captureSource);
    const mimeType = this.pickMimeType();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);

    this.recorder.ondataavailable = async (event) => {
      if (!event.data || event.data.size === 0) return;
      const buffer = await event.data.arrayBuffer();
      await onChunk({
        base64: arrayBufferToBase64(buffer),
        mimeType: event.data.type || mimeType || 'audio/webm',
      });
    };

    this.recorder.start(settings.chunkMs);
  }

  stop(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
  }

  private async createStream(source: AppSettings['captureSource']): Promise<MediaStream> {
    if (source === 'system') {
      return await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    }

    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  }

  private pickMimeType(): string {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
