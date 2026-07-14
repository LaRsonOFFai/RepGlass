import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractInterviewFile } from './interviewContextFiles';

let directory = '';

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'repglass-context-files-'));
});

afterAll(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

describe('interview context file import', () => {
  it('reads and formats text-based materials', async () => {
    const textPath = path.join(directory, 'profile.md');
    const jsonPath = path.join(directory, 'vacancy.json');
    fs.writeFileSync(textPath, '# Senior AQA\nPlaywright and API testing', 'utf8');
    fs.writeFileSync(jsonPath, '{"stack":["TypeScript","Playwright"]}', 'utf8');

    const text = await extractInterviewFile(textPath);
    const json = await extractInterviewFile(jsonPath);

    expect(text).toEqual(expect.objectContaining({ name: 'profile.md', sourceType: 'text' }));
    expect(text.content).toContain('Playwright');
    expect(json.content).toContain('\n  "stack"');
  });

  it('extracts selectable text from a PDF vacancy', async () => {
    const pdfPath = path.join(directory, 'vacancy.pdf');
    fs.writeFileSync(pdfPath, createPdf('TypeScript Playwright API interview'));

    const result = await extractInterviewFile(pdfPath);

    expect(result.sourceType).toBe('document');
    expect(result.content).toContain('TypeScript Playwright API interview');
  });

  it('marks media for API transcription without loading it into memory', async () => {
    const mediaPath = path.join(directory, 'interview.mp3');
    fs.writeFileSync(mediaPath, Buffer.from([0x49, 0x44, 0x33]));

    await expect(extractInterviewFile(mediaPath)).resolves.toEqual({
      name: 'interview.mp3',
      mediaPath,
      sourceType: 'media',
    });
  });
});

function createPdf(text: string): Buffer {
  const escaped = text.replace(/[()\\]/g, (character) => `\\${character}`);
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}
