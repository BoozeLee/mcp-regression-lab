import { type Change, type Contract, lintContract } from './contract.ts';
import type { GoldenResult } from './golden.ts';

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const row = (cells: string[]): string => `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`;

export function renderReport(before: Contract, after: Contract, changes: Change[], golden?: GoldenResult): string {
  const breaking = changes.filter((c) => c.severity === 'breaking').length;
  const verdict = breaking ? `${breaking} breaking change(s)` : 'no breaking contract changes';
  const diffRows = changes.length
    ? changes.map((c) => row([c.severity, c.kind, c.tool, c.detail])).join('\n')
    : row(['-', '-', '-', 'contracts are identical']);
  const lint = lintContract(after);
  const lintSection = `<h2>Contract hygiene <small>(current snapshot, heuristic)</small></h2>
<table><tr><th>severity</th><th>kind</th><th>tool</th><th>detail</th></tr>
${lint.length ? lint.map((c) => row([c.severity, c.kind, c.tool, c.detail])).join('\n') : row(['-', '-', '-', 'no findings'])}</table>`;
  const goldenSection = golden
    ? `<h2>Tool-selection tests <small>(probabilistic: ${esc(golden.model)}, ${golden.repeat} runs each)</small></h2>
<table><tr><th>case</th><th>expected tool</th><th>pass rate</th><th>failures</th></tr>
${golden.cases
  .map((c) =>
    row([
      c.id,
      c.expectTool,
      `${Math.round(c.passRate * 100)}%`,
      [...new Set(c.runs.filter((r) => !r.pass).map((r) => r.reason))].join('; ') || '-',
    ]),
  )
  .join('\n')}</table>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP Contract Report</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#ddd;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#eee;--muted:#aaa;--line:#333;--bad:#f2b8b5}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 16px}
table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border-bottom:1px solid var(--line);padding:.4rem;text-align:left;vertical-align:top}
small,.note{color:var(--muted)}.verdict{font-size:1.2rem;font-weight:600}.bad{color:var(--bad)}
</style></head><body>
<h1>MCP contract report</h1>
<p>Server: <code>${esc(after.server)}</code><br>Baseline: ${esc(before.takenAt)} (${before.tools.length} tools) &rarr; Current: ${esc(after.takenAt)} (${after.tools.length} tools)</p>
<p class="verdict ${breaking ? 'bad' : ''}">${esc(verdict)}</p>
<h2>Contract diff <small>(deterministic)</small></h2>
<table><tr><th>severity</th><th>kind</th><th>tool</th><th>detail</th></tr>
${diffRows}</table>
${goldenSection}
${lintSection}
<p class="note">This report compares published tool contracts and tests model tool selection. It is not a security audit or certification; model-based results vary between runs.</p>
</body></html>
`;
}
