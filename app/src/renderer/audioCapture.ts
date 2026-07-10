import type { AppSettings, AudioChunkPayload } from '../main/types';

type ChunkHandler = (payload: AudioChunkPayload) => void | Promise<void>;
type CommitHandler = () => void | Promise<void>;

type WorkletFrame = {
  pcm: ArrayBuffer;
  rms: number;
  durationMs: number;
};

export class AudioCapture {
  private streams: MediaStream[] = [];
  private context: AudioContext | null = null;
  private sourceNodes: MediaStreamAudioSourceNode[] = [];
  private mixNodes: GainNode[] = [];
  private workletNode: AudioWorkletNode | null = null;
  private silentSink: GainNode | null = null;
  private preRoll: AudioChunkPayload[] = [];
  private speechActive = false;
  private silenceMs = 0;
  private utteranceMs = 0;
  private noiseFloor = 0.0004;
  private onCommit: CommitHandler | null = null;

  async start(settings: AppSettings, onChunk: ChunkHandler, onCommit: CommitHandler): Promise<void> {
    if (this.context) return;

    try {
      this.streams = await this.createStreams(settings.captureSource);
      this.onCommit = onCommit;
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.context = context;
      const workletUrl = new URL('./pcmCapture.worklet.js', window.location.href);
      await context.audioWorklet.addModule(workletUrl.href);

      const workletNode = new AudioWorkletNode(context, 'repglass-pcm-capture');
      this.workletNode = workletNode;
      this.silentSink = context.createGain();
      this.silentSink.gain.value = 0;

      workletNode.port.onmessage = (event: MessageEvent<WorkletFrame>) => {
        this.handleFrame(event.data, settings.captureSource, onChunk);
      };

      const inputGain = this.streams.length > 1 ? 0.68 : 1;
      for (const stream of this.streams) {
        const sourceNode = context.createMediaStreamSource(stream);
        const mixNode = context.createGain();
        mixNode.gain.value = inputGain;
        sourceNode.connect(mixNode);
        mixNode.connect(workletNode);
        this.sourceNodes.push(sourceNode);
        this.mixNodes.push(mixNode);
      }

      workletNode.connect(this.silentSink);
      this.silentSink.connect(context.destination);
      await context.resume();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    if (this.speechActive) void this.onCommit?.();
    this.workletNode?.disconnect();
    this.mixNodes.forEach((node) => node.disconnect());
    this.sourceNodes.forEach((node) => node.disconnect());
    this.silentSink?.disconnect();
    void this.context?.close();
    this.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    this.streams = [];
    this.context = null;
    this.sourceNodes = [];
    this.mixNodes = [];
    this.workletNode = null;
    this.silentSink = null;
    this.preRoll = [];
    this.speechActive = false;
    this.silenceMs = 0;
    this.utteranceMs = 0;
    this.noiseFloor = 0.0004;
    this.onCommit = null;
  }

  private handleFrame(frame: WorkletFrame, source: AppSettings['captureSource'], onChunk: ChunkHandler): void {
    const payload: AudioChunkPayload = {
      base64: arrayBufferToBase64(frame.pcm),
      sampleRate: 24_000,
    };
    const minimumThreshold = source === 'microphone' ? 0.003 : 0.0008;
    const threshold = Math.max(minimumThreshold, this.noiseFloor * 2.2);
    const hasVoice = frame.rms >= threshold;

    if (!this.speechActive) {
      if (!hasVoice) this.noiseFloor = this.noiseFloor * 0.95 + frame.rms * 0.05;
      this.preRoll.push(payload);
      this.preRoll = this.preRoll.slice(-6);
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

    if (this.silenceMs >= 900 || this.utteranceMs >= 15_000) {
      void this.onCommit?.();
      this.speechActive = false;
      this.silenceMs = 0;
      this.utteranceMs = 0;
      this.preRoll = [];
    }
  }

  private async createStreams(source: AppSettings['captureSource']): Promise<MediaStream[]> {
    if (source === 'system') return [await this.createSystemStream()];
    if (source === 'microphone') return [await this.createMicrophoneStream()];

    const streams: MediaStream[] = [];
    try {
      streams.push(await this.createSystemStream());
      streams.push(await this.createMicrophoneStream());
      return streams;
    } catch (error) {
      streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
      const message = error instanceof Error ? error.message : 'неизвестная ошибка аудиозахвата';
      throw new Error(`Не удалось включить системный звук и микрофон одновременно: ${message}`, { cause: error });
    }
  }

  private async createSystemStream(): Promise<MediaStream> {
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    const audioTracks = displayStream.getAudioTracks();
    displayStream.getVideoTracks().forEach((track) => track.stop());
    if (!audioTracks.length) {
      displayStream.getTracks().forEach((track) => track.stop());
      throw new Error('Системная аудиодорожка недоступна. Проверьте настройки вывода звука Windows.');
    }
    return new MediaStream(audioTracks);
  }

  private async createMicrophoneStream(): Promise<MediaStream> {
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
