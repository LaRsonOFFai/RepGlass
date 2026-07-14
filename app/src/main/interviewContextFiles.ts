import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';

const MAX_TEXT_FILE_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_FILE_BYTES = 100 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log']);
const MEDIA_EXTENSIONS = new Set(['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm']);

export type ExtractedInterviewFile = {
  name: string;
  content?: string;
  mediaPath?: string;
  sourceType: 'text' | 'document' | 'media';
};

export async function extractInterviewFile(filePath: string): Promise<ExtractedInterviewFile> {
  const extension = path.extname(filePath).toLocaleLowerCase('en-US');
  const name = path.basename(filePath);
  const size = fs.statSync(filePath).size;

  if (MEDIA_EXTENSIONS.has(extension)) {
    if (size > MAX_MEDIA_FILE_BYTES) throw new Error('Аудио или видео превышает 100 МБ');
    return { name, mediaPath: filePath, sourceType: 'media' };
  }
  if (size > MAX_TEXT_FILE_BYTES) throw new Error('Документ превышает 8 МБ');

  if (TEXT_EXTENSIONS.has(extension)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const content = extension === '.json' ? readableJson(raw) : raw;
    return { name, content: requireText(content), sourceType: 'text' };
  }
  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return { name, content: requireText(result.value), sourceType: 'document' };
  }
  if (extension === '.pdf') {
    return { name, content: requireText(await extractPdfText(filePath)), sourceType: 'document' };
  }
  throw new Error(`Формат ${extension || 'без расширения'} пока не поддерживается`);
}

export function isMediaInterviewFile(filePath: string): boolean {
  return MEDIA_EXTENSIONS.has(path.extname(filePath).toLocaleLowerCase('en-US'));
}

async function extractPdfText(filePath: string): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(fs.readFileSync(filePath)),
    disableFontFace: true,
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines = content.items
        .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
        .filter(Boolean);
      pages.push(lines.join(' '));
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages.join('\n\n');
}

function readableJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function requireText(value: string): string {
  const text = value.replace(/\0/g, '').trim();
  if (!text) throw new Error('В файле не найден текст');
  return text;
}
