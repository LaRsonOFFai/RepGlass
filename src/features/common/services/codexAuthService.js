const { app } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_MODEL = process.env.OPENAI_CODEX_MODEL || 'gpt-5.5';
const EXEC_TIMEOUT_MS = Number.parseInt(process.env.OPENAI_CODEX_TIMEOUT_MS || '180000', 10);
const STATUS_TIMEOUT_MS = 15000;
const OUTPUT_LIMIT = 256 * 1024;

function getWritableRoot() {
    try {
        if (app?.isReady()) {
            return app.getPath('userData');
        }
    } catch (_) {}
    return path.join(os.tmpdir(), 'repglass');
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function trimOutput(value) {
    if (!value) return '';
    if (value.length <= OUTPUT_LIMIT) return value;
    return value.slice(value.length - OUTPUT_LIMIT);
}

function getPathEntries() {
    return (process.env.PATH || '')
        .split(path.delimiter)
        .map(entry => entry.trim())
        .filter(Boolean);
}

function getCodexLaunch() {
    if (process.platform !== 'win32') {
        return { command: 'codex', prefixArgs: [], shell: false };
    }

    for (const entry of getPathEntries()) {
        const scriptPath = path.join(entry, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
        if (!fs.existsSync(scriptPath)) continue;

        const localNode = path.join(entry, 'node.exe');
        return {
            command: fs.existsSync(localNode) ? localNode : 'node.exe',
            prefixArgs: [scriptPath],
            shell: false,
        };
    }

    return { command: 'codex.cmd', prefixArgs: [], shell: true };
}

function runCodex(args, options = {}) {
    const launch = getCodexLaunch();
    const timeoutMs = options.timeoutMs || EXEC_TIMEOUT_MS;
    const finalArgs = [...launch.prefixArgs, ...args];

    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;

        const child = spawn(launch.command, finalArgs, {
            cwd: ensureDir(options.cwd || getWritableRoot()),
            env: process.env,
            shell: launch.shell,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };

        const timer = setTimeout(() => {
            try {
                child.kill('SIGTERM');
            } catch (_) {}
            finish(reject, new Error(`Codex command timed out after ${timeoutMs}ms.`));
        }, timeoutMs);

        child.stdout.on('data', chunk => {
            stdout = trimOutput(stdout + chunk.toString('utf8'));
        });

        child.stderr.on('data', chunk => {
            stderr = trimOutput(stderr + chunk.toString('utf8'));
        });

        child.on('error', error => {
            finish(reject, error);
        });

        child.on('close', code => {
            if (code === 0) {
                finish(resolve, { stdout, stderr, code });
                return;
            }

            const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
            finish(reject, new Error(details || `Codex exited with code ${code}.`));
        });

        if (typeof options.stdin === 'string') {
            child.stdin.end(options.stdin, 'utf8');
        } else {
            child.stdin.end();
        }
    });
}

function getImageExtension(mimeType) {
    if (mimeType === 'image/png') return '.png';
    if (mimeType === 'image/webp') return '.webp';
    return '.jpg';
}

class CodexAuthService {
    constructor() {
        this.defaultModel = DEFAULT_MODEL;
    }

    async getStatus() {
        try {
            const [versionResult, loginResult] = await Promise.all([
                runCodex(['--version'], { timeoutMs: STATUS_TIMEOUT_MS }).catch(error => ({ error })),
                runCodex(['login', 'status'], { timeoutMs: STATUS_TIMEOUT_MS }).catch(error => ({ error })),
            ]);

            if (versionResult.error) {
                return {
                    available: false,
                    loggedIn: false,
                    method: null,
                    version: null,
                    error: versionResult.error.message || 'Codex CLI is not available.',
                };
            }

            const statusText = (loginResult.stdout || loginResult.stderr || '').trim();
            const loggedIn = !loginResult.error && /logged in/i.test(statusText);

            return {
                available: true,
                loggedIn,
                method: loggedIn ? statusText.split(/\r?\n/).find(Boolean) : null,
                version: (versionResult.stdout || versionResult.stderr || '').trim().split(/\r?\n/).find(Boolean) || 'codex',
                error: loginResult.error ? loginResult.error.message : null,
            };
        } catch (error) {
            return {
                available: false,
                loggedIn: false,
                method: null,
                version: null,
                error: error.message || 'Unable to check Codex status.',
            };
        }
    }

    startLogin() {
        if (process.platform === 'win32') {
            const loginCommand = [
                'codex login',
                'Write-Host ""',
                'Write-Host "OpenAI Codex login finished. You can close this window."',
            ].join('; ');

            const child = spawn('powershell.exe', [
                '-NoExit',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                loginCommand,
            ], {
                detached: true,
                stdio: 'ignore',
                windowsHide: false,
            });
            child.unref();
            return { success: true };
        }

        const child = spawn('codex', ['login'], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        return { success: true };
    }

    async runPrompt({ prompt, model, images = [] }) {
        const status = await this.getStatus();
        if (!status.available) {
            throw new Error(status.error || 'Codex CLI is not installed or not available in PATH.');
        }
        if (!status.loggedIn) {
            throw new Error('OpenAI Codex is not logged in. Use "Sign in with OpenAI Codex" first.');
        }

        const runId = `${Date.now()}-${crypto.randomUUID()}`;
        const root = ensureDir(path.join(getWritableRoot(), 'codex-runs', runId));
        const outputPath = path.join(root, 'answer.txt');

        const args = [
            'exec',
            '--skip-git-repo-check',
            '--ephemeral',
            '--ignore-rules',
            '--sandbox',
            'read-only',
            '-C',
            root,
            '-m',
            model || this.defaultModel,
            '-o',
            outputPath,
        ];

        for (const image of images) {
            if (!image?.data) continue;
            const extension = getImageExtension(image.mimeType);
            const imagePath = path.join(root, `screen-${crypto.randomUUID()}${extension}`);
            fs.writeFileSync(imagePath, Buffer.from(image.data, 'base64'));
            args.push('-i', imagePath);
        }

        args.push('-');

        const result = await runCodex(args, {
            cwd: root,
            stdin: prompt,
            timeoutMs: EXEC_TIMEOUT_MS,
        });

        if (fs.existsSync(outputPath)) {
            const answer = fs.readFileSync(outputPath, 'utf8').trim();
            if (answer) return answer;
        }

        const fallback = (result.stdout || '').trim();
        if (fallback) return fallback;

        throw new Error('Codex finished without returning an answer.');
    }
}

module.exports = new CodexAuthService();
