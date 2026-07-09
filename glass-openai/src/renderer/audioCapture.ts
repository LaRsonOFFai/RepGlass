import type { AppSettings, AudioChunkPayload } from '../main/types';

type ChunkHandler = (payload: AudioChunkPayload) => void | Promise<void>;
type CommitHandler = () => void | Promise<void>;

type WorkletFrame = {
  pcm: ArrayBuffer;
  rms: number;
  durationMs: number;
};

export class AudioCapture {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private silentSink: GainNode | null = null;
  private preRoll: AudioChunkPayload[] = [];
  private speechActive = false;
  private silenceMs = 0;
  private utteranceMs = 0;
  private noiseFloor = 0.002;
  private onCommit: CommitHandler | null = null;

  async start(settings: AppSettings, onChunk: ChunkHandler, onCommit: CommitHandler): Promise<void> {
    if (this.context) return;

    this.stream = await this.createStream(settings.captureSource);
    this.onCommit = onCommit;
    this.context = new AudioContext({ latencyHint: 'interactive' });
    await this.context.audioWorklet.addModule(new URL('./pcmCapture.worklet.js', import.meta.url));

    this.sourceNode = this.context.createMediaStreamSource(this.stream);
    this.workletNode = new AudioWorkletNode(this.context, 'repglass-pcm-capture');
    this.silentSink = this.context.createGain();
    this.silentSink.gain.value = 0;

    this.workletNode.port.onmessage = (event: MessageEvent<WorkletFrame>) => {
      this.handleFrame(event.data, settings.captureSource, onChunk);
    };

    this.sourceNode.connect(this.workletNode);
    this.workletNode.connect(this.silentSink);
    this.silentSink.connect(this.context.destination);
    await this.context.resume();
  }

  stop(): void {
    if (this.speechActive) void this.onCommit?.();
    this.workletNode?.disconnect();
    this.sourceNode?.disconnect();
    this.silentSink?.disconnect();
    void this.context?.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.context = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.silentSink = null;
    this.preRoll = [];
    this.speechActive = false;
    this.silenceMs = 0;
    this.utteranceMs = 0;
    this.onCommit = null;
  }

  private handleFrame(frame: WorkletFrame, source: AppSettings['captureSource'], onChunk: ChunkHandler): void {
    const payload: AudioChunkPayload = {
      base64: arrayBufferToBase64(frame.pcm),
      sampleRate: 24_000,
    };
    const minimumThreshold = source === 'system' ? 0.003 : 0.008;
    const threshold = Math.max(minimumThreshold, this.noiseFloor * 3);
    const hasVoice = frame.rms >= threshold;

    if (!this.speechActive) {
      if (!hasVoice) this.noiseFloor = this.noiseFloor * 0.95 + frame.rms * 0.05;
      this.preRoll.push(payload);
      this.preRoll = this.preRoll.slice(-4);
      if (!hasVoice) return;

      this.speechActive = true;
      this.silenceMs = 0;
      this.utteranceMs = this.preRoll.length * frame.durationMs;
      for (const buffered of this.preRoll) void onChunk(buffered);
      this.preRoll = [];
      return;
    }

    void onChunk(payload);
    this.utteranceMs += frame.durationMs;
    this.silenceMs = hasVoice ? 0 : this.silenceMs + frame.durationMs;

    if (this.silenceMs >= 700 || this.utteranceMs >= 12_000) {
      void this.onCommit?.();
      this.speechActive = false;
      this.silenceMs = 0;
      this.utteranceMs = 0;
      this.preRoll = [];
    }
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
