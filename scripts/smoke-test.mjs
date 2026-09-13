import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = 8878;
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', d => { output += d.toString(); });
child.stderr.on('data', d => { output += d.toString(); });

async function waitForServer() {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return;
    } catch {}
    await delay(150);
  }
  throw new Error(`Server did not start.\n${output}`);
}

async function expect(path, options, status, includes = null) {
  const r = await fetch(`${base}${path}`, options);
  const text = await r.text();
  if (r.status !== status) throw new Error(`${path}: expected ${status}, got ${r.status}: ${text}`);
  if (includes && !text.includes(includes)) throw new Error(`${path}: missing ${includes}`);
  return { status: r.status, text };
}

try {
  await waitForServer();
  await expect('/health', undefined, 200, 'livescope');
  await expect('/api/tools', undefined, 200, '"liveResolver":"ready"');
  await expect('/', undefined, 200, 'LiveScope');
  await expect('/monitor', undefined, 200, 'LiveScope');
  await expect('/api/live/resolve', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: '!invalid' })
  }, 400, 'Invalid username');
  await expect('/api/chat/connect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'example_user' })
  }, 503, 'EULERSTREAM_API_KEY');
  console.log('LiveScope smoke tests: PASS');
} finally {
  child.kill('SIGTERM');
  await delay(250);
  if (!child.killed) child.kill('SIGKILL');
}
