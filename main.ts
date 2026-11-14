// Entry lifecycle: bind an ephemeral port, register it with the trial env, then poll
// until the env says the trial is over and exit 0. The env lives at MAKEFUN_ENV_URL
// (http://store:8080 in a trial); without it there is nothing to talk to, so exit 1.
//
// The env owns port 8080, so this process always binds port 0 and lets the kernel pick.
// Registration is first-come-first-served: a 200 means we won, a 409 means another entry
// already registered (we keep waiting like any other process). The done poll never holds
// a request open; it answers at once with {"done": false} until the suite has finished
// and written its export, then {"done": true}.
//
// main.ts imports its own server and nothing else: no package, no Node built-in, no model
// call. The suite scores the server app.ts builds; this file is only the handshake.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One register or done request may take this long before it is abandoned and retried.
const REQUEST_TIMEOUT_MS = 30_000;
// First wait between retries, and the longest: exponential from here, capped there.
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait after `failures` failed requests: doubles from RETRY_FIRST_MS, capped.
function backoffMs(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(failures, 8));
}

// POST the bound port until the env accepts it. 200 is the normal answer; 409 means a
// first register already won, which is not this process's to fix. 400 and 405 are
// contract errors and end the program; a network error or another status is retried,
// since the env may still be starting.
async function register(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    }
    await wait(backoffMs(failures));
    failures += 1;
  }
}

// Poll GET /done until it answers {"done": true}; never return before that.
async function waitForDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await wait(backoffMs(failures));
    failures += 1;
  }
}

// Bound the port, register it, then wait for the env: the whole life of the process.
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
