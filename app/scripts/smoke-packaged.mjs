import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(appRoot, 'release', 'win-unpacked', 'RepGlass.exe');
const userData = path.join(os.tmpdir(), `repglass-packaged-smoke-${process.pid}`);

async function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForPage(endpoint, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const pages = targets.filter((target) => target.type === 'page');
        if (pages.length > 0) return pages;
      }
    } catch {
      // The debug endpoint appears after Electron has unpacked and initialized.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Packaged Electron renderer did not start in time');
}

function connectCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    socket.once('open', () => {
      let nextId = 0;
      const pending = new Map();
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      });
      const send = (method, params = {}) =>
        new Promise((requestResolve, requestReject) => {
          const id = ++nextId;
          pending.set(id, { resolve: requestResolve, reject: requestReject });
          socket.send(JSON.stringify({ id, method, params }));
        });
      resolve({ socket, send });
    });
    socket.once('error', reject);
  });
}

async function run() {
  if (process.platform !== 'win32') throw new Error('Packaged smoke test currently supports Windows only');
  await fs.access(executable);
  const port = await reservePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const processHandle = spawn(
    executable,
    [`--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`],
    { stdio: 'ignore' },
  );
  let cdp;

  try {
    const deadline = Date.now() + 45_000;
    const pages = await waitForPage(endpoint, deadline);
    if (pages.length !== 1) throw new Error(`Expected one renderer page, received ${pages.length}`);
    cdp = await connectCdp(pages[0].webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');

    const evaluate = async (expression) => {
      const response = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails) {
        throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      }
      return response.result.value;
    };

    let rendererReady = false;
    while (Date.now() < deadline) {
      rendererReady = await evaluate(`Boolean(window.glass && document.querySelector('.workspace-panel'))`);
      if (rendererReady) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!rendererReady) throw new Error('Packaged RepGlass workspace is missing');

    const result = await evaluate(`(async () => {
      const codex = await window.glass.auth.getCodexStatus();
      return {
        href: location.href,
        title: document.title,
        workspaceVisible: Boolean(document.querySelector('.workspace-panel')),
        hasPreloadApi: Boolean(window.glass),
        codexVersion: codex.version,
        codexError: codex.error
      };
    })()`);

    if (result.href !== 'repglass://app/index.html') throw new Error(`Unexpected renderer URL: ${result.href}`);
    if (result.title !== 'RepGlass' || !result.workspaceVisible || !result.hasPreloadApi) {
      throw new Error(`Packaged renderer is incomplete: ${JSON.stringify(result)}`);
    }
    if (!/^\d+\.\d+\.\d+/.test(result.codexVersion || '') || result.codexError) {
      throw new Error(`Bundled Codex App Server failed: ${result.codexError || result.codexVersion || 'no version'}`);
    }

    console.log(JSON.stringify({ executable: path.basename(executable), pages: pages.length, ...result }, null, 2));
  } finally {
    if (cdp?.socket.readyState === WebSocket.OPEN) {
      cdp.socket.send(JSON.stringify({ id: 999999, method: 'Browser.close', params: {} }));
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    cdp?.socket.terminate();
    if (!processHandle.killed && processHandle.exitCode === null) processHandle.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (userData.startsWith(path.join(os.tmpdir(), 'repglass-packaged-smoke-'))) {
      await fs.rm(userData, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

await run();
