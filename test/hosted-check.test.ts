import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const run = promisify(execFile);
const script = join(process.cwd(), 'scripts/hosted-check.ts');

type Finding = { severity: string; kind: string; tool: string; detail: string };
type Fixture = {
  url: string;
  bypassHeaders: (string | undefined)[];
  close: () => Promise<void>;
};

// The exact 200 body a healthy hosted check returns; the auth-wall guard
// keys off `changes` being an array, so keep it faithful.
const snapshotBody = (dashboardUrl: string) => ({
  ok: true,
  status: 'clean',
  error: null,
  snapshotId: 'snap_01',
  tools: 1,
  breaking: [],
  changes: [],
  lint: [],
  golden: null,
  dashboardUrl,
});

async function fixture(
  build: (url: string) => { status: number; headers: Record<string, string>; body: string },
): Promise<Fixture> {
  const bypassHeaders: (string | undefined)[] = [];
  let url = '';
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    bypassHeaders.push(req.headers['x-vercel-protection-bypass'] as string | undefined);
    const r = build(url);
    res.writeHead(r.status, r.headers).end(r.body);
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return {
    url,
    bypassHeaders,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

async function hostedCheck(
  url: string,
  options: { bypassSecret?: string } = {},
): Promise<{ stdout: string; stderr: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'mrl-hosted-check-'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOSTED_URL: url,
    API_TOKEN: 'mrl_test',
    SERVER_ID: 'server-id',
    GITHUB_OUTPUT: join(dir, 'output'),
  };
  // Isolate the bypass header from any secret in the ambient environment.
  delete env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (options.bypassSecret !== undefined) env.VERCEL_AUTOMATION_BYPASS_SECRET = options.bypassSecret;
  const result = await run('node', [script], { cwd: dir, env });
  return { ...result, dir };
}

const readFindings = (dir: string): Finding[] =>
  JSON.parse(readFileSync(join(dir, 'diff.json'), 'utf8'));

test('clean snapshot exits 0, writes empty findings and appends GITHUB_OUTPUT', async () => {
  const fx = await fixture((url) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshotBody(`${url}/dashboard`)),
  }));
  try {
    const r = await hostedCheck(fx.url);
    assert.match(r.stdout, /^ok=true$/m);
    assert.deepEqual(readFindings(r.dir), []);
    assert.equal(readFileSync(join(r.dir, 'lint.json'), 'utf8'), '[]');
    const output = readFileSync(join(r.dir, 'output'), 'utf8');
    assert.match(output, /^ok=true$/m);
    assert.match(output, /^status=clean$/m);
    assert.match(output, /^breaking=0$/m);
    assert.match(output, /^golden-regressions=0$/m);
  } finally {
    await fx.close();
  }
});

// An auth wall answers 200 with HTML; without the snapshot-body guard the
// script would crash on [...undefined] and report a TypeError instead.
test('a 200 login page is reported as a missing snapshot body, not a TypeError', async () => {
  const fx = await fixture(() => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: '<!doctype html><html><head><title>Log in</title></head><body>Vercel Wall</body></html>',
  }));
  try {
    const r = await hostedCheck(fx.url);
    assert.match(r.stderr, /without a snapshot body/);
    assert.match(r.stderr, /content-type text\/html/);
    assert.ok(!/TypeError/.test(r.stderr), 'guard crashed with a TypeError instead of a clear message');
    const findings = readFindings(r.dir);
    assert.deepEqual(findings.map((f) => f.kind), ['check-failed']);
    assert.match(findings[0].detail, /without a snapshot body/);
    assert.match(findings[0].detail, /content-type text\/html/);
  } finally {
    await fx.close();
  }
});

test('a 429 rate-limit response reports the hosted check failure status', async () => {
  const fx = await fixture(() => ({
    status: 429,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: 'a CI check ran for this server less than a minute ago' }),
  }));
  try {
    const r = await hostedCheck(fx.url);
    assert.match(r.stderr, /hosted check failed \(429\)/);
    assert.match(r.stderr, /less than a minute ago/);
    const findings = readFindings(r.dir);
    assert.deepEqual(findings.map((f) => f.kind), ['check-failed']);
    assert.match(findings[0].detail, /hosted check failed \(429\)/);
  } finally {
    await fx.close();
  }
});

// assert.ok with a fixed message, never assert.equal: a failure must not echo the secret.
test('sends x-vercel-protection-bypass only when VERCEL_AUTOMATION_BYPASS_SECRET is set', async () => {
  const canary = 'bypass-canary-not-a-real-secret';
  const fx = await fixture((url) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(snapshotBody(`${url}/dashboard`)),
  }));
  try {
    await hostedCheck(fx.url);
    // Snapshot into locals: the fixture array mutates between the two child runs.
    const withoutSecret = [...fx.bypassHeaders];
    assert.ok(
      withoutSecret.length === 1 && withoutSecret[0] === undefined,
      'bypass header sent without VERCEL_AUTOMATION_BYPASS_SECRET',
    );
    await hostedCheck(fx.url, { bypassSecret: canary });
    const withSecret = [...fx.bypassHeaders];
    assert.ok(
      withSecret.length === 2 && withSecret[1] === canary,
      'bypass header missing when VERCEL_AUTOMATION_BYPASS_SECRET is set',
    );
  } finally {
    await fx.close();
  }
});
