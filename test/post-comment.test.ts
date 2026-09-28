import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderComment } from '../scripts/post-comment.ts';

const run = promisify(execFile);

test('renderComment marks breaking vs clean and lists lint findings', () => {
  const breaking = renderComment('https://x/mcp', [{ severity: 'breaking', kind: 'tool-removed', tool: 't', detail: 'gone' }], []);
  assert.match(breaking, /warning.*1 breaking change/);
  const clean = renderComment('https://x/mcp', [], [{ severity: 'warning', kind: 'thin-description', tool: 't', detail: 'short' }]);
  assert.match(clean, /white_check_mark/);
  assert.match(clean, /thin-description/);
});

// Minimal mock of the two GitHub REST endpoints post-comment.ts calls: list comments (GET) and create/update (POST/PATCH).
async function mockGitHub(existing: { id: number; body: string }[]): Promise<{ url: string; calls: { method: string; path: string; auth: string }[]; close: () => Promise<void> }> {
  const calls: { method: string; path: string; auth: string }[] = [];
  const http: Server = createServer(async (req, res) => {
    calls.push({ method: req.method!, path: req.url!, auth: req.headers.authorization ?? '' });
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(existing));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const { port } = http.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => http.close(() => r())) };
}

test('posts a new comment when none exists, exits 0 when clean', async () => {
  const gh = await mockGitHub([]);
  writeFileSync('/tmp/diff-clean.json', '[]');
  writeFileSync('/tmp/lint-clean.json', '[]');
  try {
    await run('node', ['scripts/post-comment.ts',
      '--diff', '/tmp/diff-clean.json', '--lint', '/tmp/lint-clean.json', '--server', 's',
      '--repo', 'o/r', '--pr', '5', '--token', 'tok'], {
      env: { ...process.env, GITHUB_API: gh.url },
    });
  } finally {
    await gh.close();
  }
  assert.deepEqual(gh.calls.map((c) => c.method), ['GET', 'POST']);
  assert.equal(gh.calls[1].auth, 'Bearer tok');
});

test('updates the existing comment instead of creating a duplicate', async () => {
  const gh = await mockGitHub([{ id: 42, body: '<!-- mcp-regression-lab -->\nold' }]);
  writeFileSync('/tmp/diff-clean2.json', '[]');
  writeFileSync('/tmp/lint-clean2.json', '[]');
  try {
    await run('node', ['scripts/post-comment.ts',
      '--diff', '/tmp/diff-clean2.json', '--lint', '/tmp/lint-clean2.json', '--server', 's',
      '--repo', 'o/r', '--pr', '5', '--token', 'tok'], { env: { ...process.env, GITHUB_API: gh.url } });
  } finally {
    await gh.close();
  }
  assert.deepEqual(gh.calls.map((c) => c.method), ['GET', 'PATCH']);
  assert.match(gh.calls[1].path, /\/issues\/comments\/42$/);
});

test('exits 1 when a breaking change is present', async () => {
  const gh = await mockGitHub([]);
  writeFileSync('/tmp/diff-breaking.json', JSON.stringify([{ severity: 'breaking', kind: 'k', tool: 't', detail: 'd' }]));
  writeFileSync('/tmp/lint-breaking.json', '[]');
  let code = 0;
  try {
    await run('node', ['scripts/post-comment.ts',
      '--diff', '/tmp/diff-breaking.json', '--lint', '/tmp/lint-breaking.json', '--server', 's',
      '--repo', 'o/r', '--pr', '5', '--token', 'tok'], { env: { ...process.env, GITHUB_API: gh.url } });
  } catch (err) {
    code = (err as { code: number }).code;
  } finally {
    await gh.close();
  }
  assert.equal(code, 1);
});
