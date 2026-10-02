import { systemPreferences } from 'electron';
import type { AppSettings } from './types';

export function checkScreenPermission(): void {
  if (process.platform !== 'darwin') return;
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'denied' || status === 'restricted') {
    throw new Error('Разрешите RepGlass запись экрана в Системных настройках → Конфиденциальность и безопасность → Запись экрана и системного аудио, затем перезапустите приложение.');
  }
}

export async function prepareAudioCapture(source: AppSettings['captureSource']): Promise<void> {
  if (!['both', 'system', 'microphone'].includes(source)) throw new Error('Неизвестный источник аудио');
  if (process.platform !== 'darwin') return;
  if (source !== 'microphone') checkScreenPermission();
  if (source === 'system') return;
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return;
  if (!(await systemPreferences.askForMediaAccess('microphone'))) {
    throw new Error('Разрешите RepGlass доступ к микрофону в Системных настройках → Конфиденциальность и безопасность → Микрофон, затем перезапустите приложение.');
  }
}
