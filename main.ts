// Entry point: bind an ephemeral port, register it with the env, then poll /done until the env says
// the trial is over and exit 0. The forge itself (app.ts) answers the suite in the meantime.
//
//   MAKEFUN_ENV_URL   the env's origin; without it there is nothing to register with (exit 1)
//   listen(0)         the kernel picks the port; 8080 belongs to the env
//   POST /register    {"port": N}; 200 accepted, 409 someone else won (keep waiting anyway)
//   GET /done         polled with a short capped backoff until {"done": true}

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}

const TIMEOUT_MS = 30_000;
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number): number => Math.min(2_000, 200 * 2 ** Math.min(attempt, 4));

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register refused: HTTP ${res.status} ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await pause(backoff(attempt));
  }
}

async function untilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok && ((await res.json()) as { done?: unknown }).done === true) return;
    } catch {
      // not answering yet: poll again
    }
    await pause(backoff(attempt));
  }
}

const server = createApp();
try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP port was bound');
  process.stdout.write(`[forge] listening on ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[forge] registered\n');
  await untilDone();
  server.close();
  process.stdout.write('[forge] done\n');
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
