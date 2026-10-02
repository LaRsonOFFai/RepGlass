import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.platform === 'darwin'
  ? path.join(appRoot, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'RepGlass.app', 'Contents', 'MacOS', 'RepGlass')
  : path.join(appRoot, 'release', 'win-unpacked', 'RepGlass.exe');
const userData = path.join(os.tmpdir(), `repglass-packaged-smoke-${process.pid}`);
const liveApi = process.env.REPGLASS_LIVE_API === '1';

async function createSpeechFixture(filePath) {
  const command = [
    'Add-Type -AssemblyName System.Speech',
    '$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$voice.SetOutputToWaveFile($env:REPGLASS_AUDIO_FIXTURE, $format)',
    "$voice.Speak('How do I make popcorn?')",
    '$voice.Dispose()',
  ].join('; ');
  await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
      env: { ...process.env, REPGLASS_AUDIO_FIXTURE: filePath },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errorText = '';
    child.stderr.on('data', (chunk) => (errorText += chunk.toString()));
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(errorText.trim() || `Speech synthesis exited with ${code}`)),
    );
  });
}

async function readPcm24kMono(filePath) {
  const wav = await fs.readFile(filePath);
  let offset = 12;
  let format;
  let audio;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      format = {
        encoding: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        sampleRate: wav.readUInt32LE(start + 4),
        bits: wav.readUInt16LE(start + 14),
      };
    }
    if (id === 'data') audio = wav.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!format || format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== 24_000 || format.bits !== 16) {
    throw new Error(`Unexpected speech fixture format: ${JSON.stringify(format)}`);
  }
  if (!audio?.length) throw new Error('Speech fixture contains no PCM audio');
  return audio.toString('base64');
}

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
  if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Packaged smoke test supports Windows and macOS');
  if (liveApi && process.platform !== 'win32') throw new Error('Live API smoke test currently supports Windows only');
  await fs.access(executable);
  const port = await reservePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const codexHome = path.join(userData, 'codex-home');
  await fs.mkdir(codexHome, { recursive: true });
  let liveAudioBase64 = '';
  if (liveApi) {
    try {
      const sourceUserData = path.join(process.env.APPDATA || '', 'RepGlass');
      const speechFixture = path.join(userData, 'live-stt.wav');
      await Promise.all([
        fs.copyFile(path.join(sourceUserData, 'repglass-store.json'), path.join(userData, 'repglass-store.json')),
        fs.copyFile(path.join(sourceUserData, 'Local State'), path.join(userData, 'Local State')),
        createSpeechFixture(speechFixture),
      ]);
      liveAudioBase64 = await readPcm24kMono(speechFixture);
    } catch (error) {
      if (userData.startsWith(path.join(os.tmpdir(), 'repglass-packaged-smoke-'))) {
        await fs.rm(userData, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }
  const processHandle = spawn(
    executable,
    [`--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`],
    {
      stdio: 'ignore',
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
    },
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
      rendererReady = await evaluate(
        `Boolean(window.glass && document.querySelector('.workspace-panel, .glass-workspace'))`,
      );
      if (rendererReady) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!rendererReady) throw new Error('Packaged RepGlass workspace is missing');

    const result = await evaluate(`(async () => {
      const runLiveApi = ${JSON.stringify(liveApi)};
      const liveAudio = ${JSON.stringify(liveAudioBase64)};
      const codex = await window.glass.auth.getCodexStatus();
      const audioContext = new AudioContext({ latencyHint: 'interactive' });
      let workletLoaded = false;
      let workletNodes = 0;
      try {
        const workletUrl = new URL('./pcmCapture.worklet.js', window.location.href);
        await audioContext.audioWorklet.addModule(workletUrl.href);
        const nodes = [
          new AudioWorkletNode(audioContext, 'repglass-pcm-capture'),
          new AudioWorkletNode(audioContext, 'repglass-pcm-capture'),
        ];
        nodes.forEach((node) => node.disconnect());
        workletNodes = nodes.length;
        workletLoaded = true;
      } finally {
        await audioContext.close();
      }
      let liveApiResult = null;
      if (runLiveApi) {
        const auth = await window.glass.auth.getState();
        if (!auth.hasApiKey) throw new Error('Copied RepGlass store has no usable API key');
        const models = await window.glass.auth.getOpenAIModels();
        const selectedModel = models.find((model) => model.id === 'gpt-6-luna') || models[0];
        if (!selectedModel) throw new Error('No compatible OpenAI answer model is available');
        const previousSettings = await window.glass.settings.get();
        await window.glass.context.clear();
        await window.glass.settings.update({
          answerProvider: 'openai-api',
          model: selectedModel.id,
          screenContext: 'off',
          profile: 'general',
          answerDetail: 'brief',
          reasoningEffort: 'low',
          autoAnswer: false
        });
        try {
          const listening = await window.glass.listen.start();
          if (!listening.success) throw new Error(listening.error || 'Realtime transcription failed');
          const transcript = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              off();
              reject(new Error('Live transcription did not return a final turn'));
            }, 20000);
            const off = window.glass.events.onTranscript((turn) => {
              if (turn.speaker !== 'me' || turn.partial) return;
              clearTimeout(timeout);
              off();
              resolve(turn.text);
            });
            window.glass.listen.sendAudioChunk({ source: 'microphone', base64: liveAudio, sampleRate: 24000 });
            window.glass.listen.commitAudio('microphone');
          });
          await window.glass.listen.stop();
          const answer = await window.glass.ask.send({
            question: 'Ответь одним словом: готово',
            includeScreen: false,
            trigger: 'manual'
          });
          liveApiResult = {
            availableModels: models.slice(0, 12).map((model) => model.id),
            selectedModel: selectedModel.id,
            realtimeConnected: true,
            transcriptReceived: Boolean(transcript && transcript.trim()),
            transcript,
            answerReceived: Boolean(answer.answer && answer.answer.trim())
          };
        } finally {
          await window.glass.settings.update(previousSettings);
        }
      }
      return {
        href: location.href,
        title: document.title,
        workspaceVisible: Boolean(document.querySelector('.workspace-panel, .glass-workspace')),
        hasPreloadApi: Boolean(window.glass),
        hasOpenAIModelDiscovery: typeof window.glass.auth.getOpenAIModels === 'function',
        workletLoaded,
        workletNodes,
        hasSmartAsk: typeof window.glass.ask.smart === 'function',
        hasOriginalCommandBar: Boolean(document.querySelector('.command-capsule .header-action')),
        hasAskCommand: [...document.querySelectorAll('.header-action')].some((element) => element.textContent?.includes('Ask')),
        hasSessionFinish: typeof window.glass.session.finish === 'function',
        hasLiveInsights: typeof window.glass.session.refreshInsights === 'function',
        hasSessionSummary: typeof window.glass.session.summarize === 'function',
        hasInterviewContext: typeof window.glass.context.get === 'function' && typeof window.glass.context.save === 'function',
        hasContextImport: typeof window.glass.context.importFile === 'function',
        hasNarrativeNavigation: typeof window.glass.context.navigateNarrative === 'function',
        contextVersion: (await window.glass.context.get()).version,
        codexAvailable: codex.available,
        codexLoggedIn: codex.loggedIn,
        codexVersion: codex.version,
        codexError: codex.error,
        liveApi: liveApiResult
      };
    })()`);

    if (result.href !== 'repglass://app/index.html') throw new Error(`Unexpected renderer URL: ${result.href}`);
    if (
      result.title !== 'RepGlass' ||
      !result.workspaceVisible ||
      !result.hasPreloadApi ||
      !result.hasOpenAIModelDiscovery ||
      !result.workletLoaded ||
      result.workletNodes !== 2 ||
      !result.hasSmartAsk ||
      !result.hasOriginalCommandBar ||
      !result.hasAskCommand ||
      !result.hasSessionFinish ||
      !result.hasLiveInsights ||
      !result.hasSessionSummary ||
      !result.hasInterviewContext ||
      !result.hasContextImport ||
      !result.hasNarrativeNavigation ||
      result.contextVersion !== 1
    ) {
      throw new Error(`Packaged renderer is incomplete: ${JSON.stringify(result)}`);
    }
    if (!result.codexAvailable || !/^\d+\.\d+\.\d+/.test(result.codexVersion || '')) {
      throw new Error(`Bundled Codex App Server failed: ${result.codexError || result.codexVersion || 'no version'}`);
    }
    if (
      liveApi &&
      (!result.liveApi?.realtimeConnected || !result.liveApi?.transcriptReceived || !result.liveApi?.answerReceived)
    ) {
      throw new Error(`Live OpenAI API check failed: ${JSON.stringify(result.liveApi)}`);
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
