import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioCapture } from './audioCapture';

type FakeTrack = {
  kind: 'audio' | 'video';
  stop: ReturnType<typeof vi.fn>;
};

class FakeMediaStream {
  constructor(private readonly tracks: FakeTrack[] = []) {}

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video');
  }

  getTracks() {
    return [...this.tracks];
  }
}

type TestableCapture = {
  createStreams: (source: 'both' | 'microphone' | 'system') => Promise<MediaStream[]>;
};

describe('audio capture sources', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('opens system loopback and microphone in combined mode', async () => {
    const systemAudio = { kind: 'audio', stop: vi.fn() } satisfies FakeTrack;
    const systemVideo = { kind: 'video', stop: vi.fn() } satisfies FakeTrack;
    const microphoneAudio = { kind: 'audio', stop: vi.fn() } satisfies FakeTrack;
    const displayStream = new FakeMediaStream([systemAudio, systemVideo]);
    const microphoneStream = new FakeMediaStream([microphoneAudio]);
    const getDisplayMedia = vi.fn().mockResolvedValue(displayStream);
    const getUserMedia = vi.fn().mockResolvedValue(microphoneStream);

    vi.stubGlobal('MediaStream', FakeMediaStream);
    vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia, getUserMedia } });

    const capture = new AudioCapture() as unknown as TestableCapture;
    const streams = await capture.createStreams('both');

    expect(streams).toHaveLength(2);
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(systemVideo.stop).toHaveBeenCalledOnce();
    expect(streams[0].getAudioTracks()).toEqual([systemAudio]);
    expect(streams[1]).toBe(microphoneStream);
  });

  it('stops system loopback if microphone capture fails', async () => {
    const systemAudio = { kind: 'audio', stop: vi.fn() } satisfies FakeTrack;
    const displayStream = new FakeMediaStream([systemAudio]);

    vi.stubGlobal('MediaStream', FakeMediaStream);
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getDisplayMedia: vi.fn().mockResolvedValue(displayStream),
        getUserMedia: vi.fn().mockRejectedValue(new Error('Microphone denied')),
      },
    });

    const capture = new AudioCapture() as unknown as TestableCapture;
    await expect(capture.createStreams('both')).rejects.toThrow(
      'Не удалось включить системный звук и микрофон одновременно: Microphone denied',
    );
    expect(systemAudio.stop).toHaveBeenCalledOnce();
  });
});
