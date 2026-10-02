import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const permissions = vi.hoisted(() => ({
  getMediaAccessStatus: vi.fn(),
  askForMediaAccess: vi.fn(),
}));
vi.mock('electron', () => ({ systemPreferences: permissions }));

import { checkScreenPermission, prepareAudioCapture } from './mediaPermissions';

describe('macOS capture permissions', () => {
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
    permissions.getMediaAccessStatus.mockReset().mockReturnValue('granted');
    permissions.askForMediaAccess.mockReset().mockResolvedValue(true);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('requests microphone consent only when needed', async () => {
    permissions.getMediaAccessStatus.mockReturnValue('not-determined');
    await prepareAudioCapture('microphone');
    expect(permissions.askForMediaAccess).toHaveBeenCalledWith('microphone');
    expect(permissions.getMediaAccessStatus).not.toHaveBeenCalledWith('screen');
  });

  it('rejects microphone denial with recovery instructions', async () => {
    permissions.getMediaAccessStatus.mockReturnValue('denied');
    permissions.askForMediaAccess.mockResolvedValue(false);
    await expect(prepareAudioCapture('microphone')).rejects.toThrow('Разрешите RepGlass доступ к микрофону');
  });

  it('does not request microphone access for system-only capture', async () => {
    await prepareAudioCapture('system');
    expect(permissions.getMediaAccessStatus).toHaveBeenCalledWith('screen');
    expect(permissions.askForMediaAccess).not.toHaveBeenCalled();
  });

  it('allows the first screen capture to trigger native consent', () => {
    permissions.getMediaAccessStatus.mockReturnValue('not-determined');
    expect(checkScreenPermission).not.toThrow();
  });

  it('blocks capture after screen permission is denied', async () => {
    permissions.getMediaAccessStatus.mockReturnValue('denied');
    expect(checkScreenPermission).toThrow('Разрешите RepGlass запись экрана');
    await expect(prepareAudioCapture('both')).rejects.toThrow('перезапустите приложение');
    expect(permissions.askForMediaAccess).not.toHaveBeenCalled();
  });

  it('leaves Windows capture free of macOS permission calls', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    await prepareAudioCapture('both');
    checkScreenPermission();
    expect(permissions.getMediaAccessStatus).not.toHaveBeenCalled();
    expect(permissions.askForMediaAccess).not.toHaveBeenCalled();
  });
});
