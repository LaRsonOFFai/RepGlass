import type { AppSettings, AudioChunkPayload, AudioInputSource } from '../main/types';

type ChunkHandler = (source: AudioInputSource, payload: AudioChunkPayload) => void | Promise<void>;
type CommitHandler = (source: AudioInputSource) => void | Promise<void>;

type WorkletFrame = {
  pcm: ArrayBuffer;
  rms: number;
  durationMs: number;
};

type CaptureInput = {
  source: AudioInputSource;
  stream: MediaStream;
};

type CapturePipeline = {
  sourceNode: MediaStreamAudioSourceNode;
  workletNode: AudioWorkletNode;
};

type VoiceState = {
  preRoll: AudioChunkPayload[];
  speechActive: boolean;
  silenceMs: number;
  utteranceMs: number;
  noiseFloor: number;
};

export class AudioCapture {
  private inputs: CaptureInput[] = [];
  private context: AudioContext | null = null;
  private pipelines: CapturePipeline[] = [];
  private silentSink: GainNode | null = null;
  private readonly voiceStates = new Map<AudioInputSource, VoiceState>();
  private onCommit: CommitHandler | null = null;

  async start(settings: AppSettings, onChunk: ChunkHandler, onCommit: CommitHandler): Promise<void> {
    if (this.context) return;

    try {
      this.inputs = await this.createStreams(settings.captureSource);
      this.onCommit = onCommit;
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.context = context;
      const workletUrl = new URL('./pcmCapture.worklet.js', window.location.href);
      await context.audioWorklet.addModule(workletUrl.href);

      this.silentSink = context.createGain();
      this.silentSink.gain.value = 0;

      for (const input of this.inputs) {
        const sourceNode = context.createMediaStreamSource(input.stream);
        const workletNode = new AudioWorkletNode(context, 'repglass-pcm-capture');
        this.voiceStates.set(input.source, this.createVoiceState());
        workletNode.port.onmessage = (event: MessageEvent<WorkletFrame>) => {
          this.handleFrame(input.source, event.data, onChunk);
        };
        sourceNode.connect(workletNode);
        workletNode.connect(this.silentSink);
        this.pipelines.push({ sourceNode, workletNode });
      }

      this.silentSink.connect(context.destination);
      await context.resume();
    } catch (error) {
      this.stop();
      throw error;
    }
  }

  stop(): void {
    for (const [source, state] of this.voiceStates) {
      if (state.speechActive) void this.onCommit?.(source);
    }
    this.pipelines.forEach(({ sourceNode, workletNode }) => {
      sourceNode.disconnect();
      workletNode.disconnect();
    });
    this.silentSink?.disconnect();
    void this.context?.close();
    this.inputs.forEach(({ stream }) => stream.getTracks().forEach((track) => track.stop()));
    this.inputs = [];
    this.context = null;
    this.pipelines = [];
    this.silentSink = null;
    this.voiceStates.clear();
    this.onCommit = null;
  }

  private handleFrame(source: AudioInputSource, frame: WorkletFrame, onChunk: ChunkHandler): void {
    const state = this.voiceStates.get(source);
    if (!state) return;
    const payload: AudioChunkPayload = {
      base64: arrayBufferToBase64(frame.pcm),
      sampleRate: 24_000,
    };
    const minimumThreshold = source === 'microphone' ? 0.003 : 0.0008;
    const threshold = Math.max(minimumThreshold, state.noiseFloor * 2.2);
    const hasVoice = frame.rms >= threshold;

    if (!state.speechActive) {
      if (!hasVoice) state.noiseFloor = state.noiseFloor * 0.95 + frame.rms * 0.05;
      state.preRoll.push(payload);
      state.preRoll = state.preRoll.slice(-6);
      if (!hasVoice) return;

      state.speechActive = true;
      state.silenceMs = 0;
      state.utteranceMs = state.preRoll.length * frame.durationMs;
      for (const buffered of state.preRoll) void onChunk(source, buffered);
      state.preRoll = [];
      return;
    }

    void onChunk(source, payload);
    state.utteranceMs += frame.durationMs;
    state.silenceMs = hasVoice ? 0 : state.silenceMs + frame.durationMs;

    if (state.silenceMs >= 900 || state.utteranceMs >= 15_000) {
      void this.onCommit?.(source);
      this.voiceStates.set(source, this.createVoiceState());
    }
  }

  private createVoiceState(): VoiceState {
    return { preRoll: [], speechActive: false, silenceMs: 0, utteranceMs: 0, noiseFloor: 0.0004 };
  }

  private async createStreams(source: AppSettings['captureSource']): Promise<CaptureInput[]> {
    if (source === 'system') return [{ source: 'system', stream: await this.createSystemStream() }];
    if (source === 'microphone') return [{ source: 'microphone', stream: await this.createMicrophoneStream() }];

    const inputs: CaptureInput[] = [];
    try {
      inputs.push({ source: 'system', stream: await this.createSystemStream() });
      inputs.push({ source: 'microphone', stream: await this.createMicrophoneStream() });
      return inputs;
    } catch (error) {
      inputs.forEach(({ stream }) => stream.getTracks().forEach((track) => track.stop()));
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
    if (!audioTracks.length || audioTracks.every((track) => track.readyState === 'ended')) {
      displayStream.getTracks().forEach((track) => track.stop());
      throw new Error('Системная аудиодорожка недоступна. Проверьте разрешение на запись системного аудио и настройки вывода звука. На macOS разрешите RepGlass запись экрана и системного аудио в Системных настройках и перезапустите приложение.');
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
