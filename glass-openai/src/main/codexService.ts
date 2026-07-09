import { app } from 'electron';
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppSettings } from './types';

export type CodexLoginStatus = {
  available: boolean;
  loggedIn: boolean;
  method?: string;
  version?: string;
  error?: string;
};

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

const CODEX_BIN = process.platform === 'win32' ? 'codex.cmd' : 'codex';

function getCodexLaunch() {
  if (process.platform !== 'win32') {
    return { command: CODEX_BIN, prefixArgs: [] as string[], shell: false };
  }

  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const script = path.join(entry, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (!fsSync.existsSync(script)) continue;

    const localNode = path.join(entry, 'node.exe');
    return {
      command: fsSync.existsSync(localNode) ? localNode : 'node.exe',
      prefixArgs: [script],
      shell: false,
    };
  }

  return { command: CODEX_BIN, prefixArgs: [] as string[], shell: true };
}

export class CodexService {
  async getStatus(): Promise<CodexLoginStatus> {
    try {
      const version = (await this.runCodex(['--version'], { timeoutMs: 10000 })).stdout.trim();
      const status = await this.runCodex(['login', 'status'], { timeoutMs: 15000 });
      const text = `${status.stdout}\n${status.stderr}`.trim();
      const loggedIn = status.code === 0 && /logged in/i.test(text);

      return {
        available: true,
        loggedIn,
        method: loggedIn ? text.replace(/\s+/g, ' ') : undefined,
        version,
        error: loggedIn ? undefined : text || 'Codex is not logged in',
      };
    } catch (error) {
      return {
        available: false,
        loggedIn: false,
        error: error instanceof Error ? error.message : 'Codex CLI is unavailable',
      };
    }
  }

  startLogin(): void {
    if (process.platform === 'win32') {
      const command = [
        'codex login',
        'Write-Host ""',
        'Write-Host "RepGlass: after Codex login finishes, close this window and press Check Codex in RepGlass."',
      ].join('; ');
      const child = spawn('powershell.exe', ['-NoExit', '-Command', command], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      return;
    }

    const child = spawn(CODEX_BIN, ['login'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }

  async answerQuestion(params: {
    question: string;
    conversation: string[];
    settings: AppSettings;
  }): Promise<string> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repglass-codex-'));
    const outputPath = path.join(tempDir, 'answer.txt');
    const prompt = [
      'You are RepGlass, a discreet live assistant.',
      'This is not a coding task. Do not inspect files, run commands, or modify anything.',
      'Answer the user directly and concisely. Use Russian unless the question asks for another language.',
      '',
      'Recent transcript:',
      params.conversation.slice(-20).join('\n') || 'No transcript yet.',
      '',
      'Latest question:',
      params.question,
    ].join('\n');

    const result = await this.runCodex(
      [
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-rules',
        '--sandbox',
        'read-only',
        '-C',
        app.getPath('userData'),
        '-m',
        params.settings.codexModel || params.settings.model,
        '-o',
        outputPath,
        '-',
      ],
      { stdin: prompt, timeoutMs: 180000 },
    );

    const answer = await fs.readFile(outputPath, 'utf8').catch(() => '');
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || 'Codex exec failed');
    }

    return answer.trim() || result.stdout.trim() || 'Codex returned no answer.';
  }

  private runCodex(args: string[], options: { stdin?: string; timeoutMs: number }): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const launch = getCodexLaunch();
      const child = spawn(launch.command, [...launch.prefixArgs, ...args], {
        windowsHide: true,
        shell: launch.shell,
      });

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Codex command timed out'));
      }, options.timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });

      if (options.stdin) {
        child.stdin?.write(options.stdin);
      }
      child.stdin?.end();
    });
  }
}
