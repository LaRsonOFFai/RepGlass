import { app, desktopCapturer, screen } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkScreenPermission } from './mediaPermissions';

export type CapturedScreen = {
  path: string;
  dataUrl: string;
  displayName: string;
  dispose: () => void;
};

export class ScreenCaptureService {
  async captureCurrentDisplay(): Promise<CapturedScreen> {
    checkScreenPermission();
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    const scale = Math.min(1, 1_920 / Math.max(display.size.width, 1));
    const thumbnailSize = {
      width: Math.max(640, Math.round(display.size.width * scale)),
      height: Math.max(360, Math.round(display.size.height * scale)),
    };
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
      fetchWindowIcons: false,
    });
    const source = sources.find((candidate) => candidate.display_id === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('Не удалось получить изображение экрана');

    const directory = path.join(app.getPath('temp'), 'RepGlass', 'captures');
    fs.mkdirSync(directory, { recursive: true });
    this.cleanupExpired(directory);

    const imagePath = path.join(directory, `${crypto.randomUUID()}.png`);
    fs.writeFileSync(imagePath, source.thumbnail.toPNG());
    const preview = source.thumbnail.resize({ width: 420, quality: 'good' }).toDataURL();

    return {
      path: imagePath,
      dataUrl: preview,
      displayName: source.name,
      dispose: () => {
        try {
          fs.rmSync(imagePath, { force: true });
        } catch {
          // The system temp cleanup will remove a locked image later.
        }
      },
    };
  }

  private cleanupExpired(directory: string): void {
    const oldestAllowed = Date.now() - 60 * 60_000;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
      const filePath = path.join(directory, entry.name);
      try {
        if (fs.statSync(filePath).mtimeMs < oldestAllowed) fs.rmSync(filePath, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}
