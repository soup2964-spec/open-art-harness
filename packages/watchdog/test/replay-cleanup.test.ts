// Signals run only inside a disposable child process. Mock Chrome PIDs are intercepted there,
// while the real harness coordinates cleanup and removes actual temporary profile directories.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const harnessPath = fileURLToPath(new URL('../src/legacy/sealed_replay.cjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const CHILD = String.raw`
const path = require('node:path');
const [mode, harness, dir] = process.argv.slice(1);
const realKill = process.kill.bind(process);
const dead = new Set();
const killing = new Set();
const fakePids = [2147483001, 2147483002];
process.kill = (pid, signal) => {
  if (!fakePids.includes(pid)) return realKill(pid, signal);
  if (signal === 0) { if (dead.has(pid)) throw new Error('ESRCH'); return true; }
  if (!killing.has(pid)) {
    killing.add(pid);
    const done = () => { dead.add(pid); console.log('DEAD ' + pid); };
    if (mode === 'signal' && pid === fakePids[1]) setTimeout(done, 700);
    else done();
  }
  return true;
};
const cache = (id, exports) => { require.cache[id] = { id, filename: id, loaded: true, exports }; };
let launches = 0;
cache(require.resolve('puppeteer-core', { paths: [path.dirname(harness)] }), {
  launch: async (opts) => {
    const index = launches++;
    if (opts.handleSIGINT !== false || opts.handleSIGTERM !== false || opts.handleSIGHUP !== false) throw new Error('competing signal handlers enabled');
    // Signal while the second Chrome launch is still in progress.
    if (mode === 'signal' && index === 1) {
      setTimeout(() => realKill(process.pid, 'SIGTERM'), 10);
      await new Promise((r) => setTimeout(r, 150));
    }
    return {
      process: () => ({ pid: fakePids[index], spawnargs: [] }),
      version: async () => {
        if (mode === 'version') throw new Error('version setup failed');
        if (mode === 'signal') return new Promise(() => {});
        return 'Chrome/test';
      },
      target: () => ({ createCDPSession: async () => { throw new Error('session setup failed'); } }),
    };
  },
});
let proxies = 0;
cache(path.join(path.dirname(harness), 'gatekeeper_proxy.cjs'), {
  startProxy: async () => {
    const index = proxies++;
    const state = { sealed: false };
    return { port: 1000 + index, state,
      seal: () => { state.sealed = true; },
      close: async () => {
        if (!state.sealed) throw new Error('closed an unsealed proxy');
        console.log('CLOSE ' + index);
      },
    };
  },
});
const { runSealedReplay } = require(harness);
const run = (index) => runSealedReplay({ profileDir: path.join(dir, 'profile-' + index), profilePrefs: {}, scenarios: {}, scenarioList: [] });
if (mode === 'signal') {
  // Pending promises do not keep Node alive; this timer is terminated by the coordinator's exit.
  setInterval(() => {}, 1000);
  void Promise.all([run(0), run(1)]).catch((e) => console.error(e.message));
} else {
  run(0).then(() => { process.exitCode = 1; }, (error) => {
    console.log('ERROR ' + error.message);
    console.log('LISTENERS ' + ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s)).join(','));
  });
}
`;

async function child(mode: string, dir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['-e', CHILD, mode, harnessPath, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`cleanup child hung: ${stdout}\n${stderr}`)); }, 8_000);
    proc.stdout.on('data', (chunk) => { stdout += String(chunk); });
    proc.stderr.on('data', (chunk) => { stderr += String(chunk); });
    proc.on('error', (error) => { clearTimeout(timeout); reject(error); });
    proc.on('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

describe('replay worker cleanup', () => {
  it('waits for every worker on SIGTERM, including a pending launch and a slow process tree', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-cleanup-signal-'));
    dirs.push(dir);
    const result = await child('signal', dir);
    expect(result.code, result.stderr).toBe(2);
    expect(result.stdout).toContain('CLOSE 0');
    expect(result.stdout).toContain('CLOSE 1');
    expect(result.stdout).toContain('DEAD 2147483002');
    expect(fs.existsSync(path.join(dir, 'profile-0'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'profile-1'))).toBe(false);
  });

  it.each(['version', 'session'])('cleans Chrome, proxy and profile if %s setup rejects after launch', async (stage) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-cleanup-setup-'));
    dirs.push(dir);
    const result = await child(stage, dir);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`ERROR ${stage} setup failed`);
    expect(result.stdout).toContain('DEAD 2147483001');
    expect(result.stdout).toContain('CLOSE 0');
    expect(result.stdout).toContain('LISTENERS 0,0,0');
    expect(fs.existsSync(path.join(dir, 'profile-0'))).toBe(false);
  });
});
