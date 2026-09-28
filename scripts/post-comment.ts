// Posts (or updates) one PR comment summarizing a contract diff + lint findings.
// No SDK: the GitHub REST API is one fetch call, consistent with the rest of this project.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { Change } from '../src/contract.ts';

const MARKER = '<!-- mcp-regression-lab -->';

export function renderComment(server: string, changes: Change[], lint: Change[]): string {
  const breaking = changes.filter((c) => c.severity === 'breaking');
  const heading = breaking.length
    ? `### :warning: MCP contract check — ${breaking.length} breaking change(s)`
    : '### :white_check_mark: MCP contract check — no breaking changes';
  const list = (items: Change[]) =>
    items.length ? items.map((c) => `- **${c.severity}** \`${c.kind}\` on \`${c.tool}\`: ${c.detail}`).join('\n') : '_none_';
  return `${MARKER}
${heading}

Server: \`${server}\`

**Contract diff**
${list(changes)}

<details><summary>Hygiene lint (${lint.length})</summary>

${list(lint)}
</details>

_Deterministic contract check; not a certification. [mcp-regression-lab](https://github.com/)_`;
}

async function findExistingCommentId(api: string, token: string): Promise<number | undefined> {
  const res = await fetch(api, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`list comments failed: ${res.status} ${await res.text()}`);
  const comments = (await res.json()) as { id: number; body: string }[];
  return comments.find((c) => c.body.startsWith(MARKER))?.id;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      diff: { type: 'string' },
      lint: { type: 'string' },
      server: { type: 'string' },
      repo: { type: 'string' }, // "owner/repo"
      pr: { type: 'string' },
      token: { type: 'string' },
    },
  });
  for (const req of ['diff', 'lint', 'server', 'repo', 'pr', 'token'] as const) {
    if (!values[req]) throw new Error(`--${req} is required`);
  }
  const changes = JSON.parse(readFileSync(values.diff!, 'utf8')) as Change[];
  const lint = JSON.parse(readFileSync(values.lint!, 'utf8')) as Change[];
  const body = renderComment(values.server!, changes, lint);
  const base = `${process.env.GITHUB_API ?? 'https://api.github.com'}/repos/${values.repo}`;
  const listUrl = `${base}/issues/${values.pr}/comments`;
  const existing = await findExistingCommentId(listUrl, values.token!);
  const url = existing ? `${base}/issues/comments/${existing}` : listUrl;
  const res = await fetch(url, {
    method: existing ? 'PATCH' : 'POST',
    headers: {
      authorization: `Bearer ${values.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`comment ${existing ? 'update' : 'create'} failed: ${res.status} ${await res.text()}`);
  console.error(`comment ${existing ? 'updated' : 'posted'} on ${values.repo}#${values.pr}`);
  if (changes.some((c) => c.severity === 'breaking')) process.exitCode = 1;
}

// Only run when executed directly (`node post-comment.ts ...`), not when imported for its exports.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error(`error: ${err.message}`);
    process.exit(2);
  });
}
