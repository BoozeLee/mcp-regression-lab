#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { type Change, type Contract, diffContracts, lintContract, snapshot } from './contract.ts';
import { type GoldenCase, type GoldenResult, ollamaAsk, runGolden } from './golden.ts';
import { renderReport } from './report.ts';
import { guardedFetch } from './hosted.ts';
import { resolveOllamaUrl } from './ollama-url.ts';

const USAGE = `mcp-lab <command>
  snapshot <url> -o contract.json          (bearer token from MCP_TOKEN env)
  diff <old.json> <new.json> [--json]      exit 1 on breaking changes
  golden <contract.json> <cases.json> [--model qwen3] [--repeat 3] -o results.json
  lint <contract.json>                     hygiene findings for one snapshot
  report <old.json> [new.json] [--golden results.json] -o report.html
                                           (one snapshot = baseline + hygiene only)`;

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

function output(path: string | undefined, text: string): void {
  if (path) writeFileSync(path, text);
  else process.stdout.write(text);
}

function format(changes: Change[], json?: boolean): string {
  if (json) return `${JSON.stringify(changes, null, 2)}\n`;
  return changes.map((c) => `${c.severity.padEnd(8)} ${c.kind.padEnd(22)} ${c.tool}: ${c.detail}`).join('\n') + '\n';
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      json: { type: 'boolean' },
      model: { type: 'string', default: 'qwen3' },
      repeat: { type: 'string', default: '3' },
      golden: { type: 'string' },
    },
  });
  const [command, a, b] = positionals;

  switch (command) {
    case 'snapshot': {
      if (!a) break;
      const contract = await snapshot(a, process.env.MCP_TOKEN, 15_000, guardedFetch);
      output(values.out, `${JSON.stringify(contract, null, 2)}\n`);
      console.error(`${contract.tools.length} tools captured from ${contract.server}`);
      return 0;
    }
    case 'diff': {
      if (!a || !b) break;
      const changes = diffContracts(readJson<Contract>(a), readJson<Contract>(b));
      output(values.out, changes.length ? format(changes, values.json) : 'no changes\n');
      return changes.some((c) => c.severity === 'breaking') ? 1 : 0;
    }
    case 'lint': {
      if (!a) break;
      const findings = lintContract(readJson<Contract>(a));
      output(values.out, findings.length ? format(findings, values.json) : 'no findings\n');
      return 0;
    }
    case 'golden': {
      if (!a || !b) break;
      const repeat = Number(values.repeat);
      if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat must be a positive integer');
      const result = await runGolden(
        readJson<Contract>(a),
        readJson<GoldenCase[]>(b),
        ollamaAsk(values.model, resolveOllamaUrl(process.env.MCP_LAB_OLLAMA_URL)),
        values.model,
        repeat,
      );
      output(values.out, `${JSON.stringify(result, null, 2)}\n`);
      for (const c of result.cases) console.error(`${Math.round(c.passRate * 100)}%\t${c.id}`);
      return 0;
    }
    case 'report': {
      if (!a) break;
      const before = readJson<Contract>(a);
      const after = b ? readJson<Contract>(b) : before;
      const golden = values.golden ? readJson<GoldenResult>(values.golden) : undefined;
      output(values.out, renderReport(before, after, diffContracts(before, after), golden));
      return 0;
    }
  }
  console.error(USAGE);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(`error: ${err.message}`);
    process.exit(2);
  },
);
