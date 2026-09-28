import type { Contract } from './contract.ts';

export type GoldenCase = {
  id: string;
  prompt: string;
  expectTool: string;
  requiredArgs?: string[];
  forbiddenTools?: string[];
};

export type ToolCall = { name: string; args: Record<string, unknown> };
export type Verdict = { pass: boolean; reason: string };
export type CaseResult = { id: string; expectTool: string; passRate: number; runs: Verdict[] };
export type GoldenResult = { model: string; repeat: number; ranAt: string; cases: CaseResult[] };
export type Ask = (contract: Contract, prompt: string) => Promise<ToolCall[]>;

export function evaluate(c: GoldenCase, calls: ToolCall[]): Verdict {
  const forbidden = calls.find((call) => c.forbiddenTools?.includes(call.name));
  if (forbidden) return { pass: false, reason: `called forbidden tool "${forbidden.name}"` };
  const hit = calls.find((call) => call.name === c.expectTool);
  if (!hit) {
    const chosen = calls.map((call) => call.name).join(', ');
    return { pass: false, reason: chosen ? `chose ${chosen} instead of ${c.expectTool}` : 'no tool called' };
  }
  const missing = (c.requiredArgs ?? []).filter((a) => hit.args?.[a] === undefined || hit.args[a] === '');
  if (missing.length) return { pass: false, reason: `missing argument(s): ${missing.join(', ')}` };
  return { pass: true, reason: 'ok' };
}

// Only asks the model which tool it would call; the customer's server is never invoked.
export function ollamaAsk(model: string, host = 'http://localhost:11434'): Ask {
  return async (contract, prompt) => {
    const res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [{ role: 'user', content: prompt }],
        tools: contract.tools.map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      message?: { tool_calls?: { function: { name: string; arguments: unknown } }[] };
    };
    return (body.message?.tool_calls ?? []).map((tc) => ({
      name: tc.function.name,
      args: (typeof tc.function.arguments === 'string'
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments) as Record<string, unknown>,
    }));
  };
}

// OpenAI-style APIs only accept ^[a-zA-Z0-9_-]{1,64}$ tool names; MCP names can hold dots and more.
function toolNameMap(contract: Contract) {
  const toApi = new Map<string, string>();
  const fromApi = new Map<string, string>();
  for (const t of contract.tools) {
    const base = t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'tool';
    let safe = base;
    for (let i = 2; fromApi.has(safe); i++) safe = `${base}_${i}`;
    toApi.set(t.name, safe);
    fromApi.set(safe, t.name);
  }
  return { toApi, fromApi };
}

/** Any OpenAI-compatible chat-completions endpoint (OpenAI, Groq, OpenRouter, Ollama /v1, …). */
export function openAICompatibleAsk(
  baseUrl: string,
  model: string,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
): Ask {
  return async (contract, prompt) => {
    const { toApi, fromApi } = toolNameMap(contract);
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        tool_choice: 'auto',
        tools: contract.tools.map((t) => ({
          type: 'function',
          function: {
            name: toApi.get(t.name),
            description: t.description ?? '',
            parameters: { type: 'object', properties: {}, ...t.inputSchema },
          },
        })),
      }),
    });
    if (!res.ok) {
      // Providers sometimes echo the credential back; never let it reach logs or the UI.
      const text = (await res.text()).slice(0, 300);
      throw new Error(`model endpoint ${res.status}: ${apiKey ? text.split(apiKey).join('***') : text}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { tool_calls?: { function: { name: string; arguments?: string } }[] } }[];
    };
    return (body.choices?.[0]?.message?.tool_calls ?? []).map((tc) => ({
      name: fromApi.get(tc.function.name) ?? tc.function.name,
      args: tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {},
    }));
  };
}

export async function runGolden(
  contract: Contract,
  cases: GoldenCase[],
  ask: Ask,
  model: string,
  repeat = 3,
  concurrency = 1,
): Promise<GoldenResult> {
  const verdicts: Verdict[][] = cases.map(() => []);
  const tasks = cases.flatMap((c, ci) => Array.from({ length: repeat }, () => [c, ci] as const));
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const [c, ci] = tasks[next++];
      try {
        verdicts[ci].push(evaluate(c, await ask(contract, c.prompt)));
      } catch (err) {
        verdicts[ci].push({ pass: false, reason: `error: ${(err as Error).message}` });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
  const results = cases.map((c, ci) => {
    const runs = verdicts[ci];
    return { id: c.id, expectTool: c.expectTool, passRate: runs.filter((r) => r.pass).length / runs.length, runs };
  });
  return { model, repeat, ranAt: new Date().toISOString(), cases: results };
}

/** Cases present in both runs whose pass rate went down. */
export function goldenRegressions(previous: CaseResult[], current: CaseResult[]): CaseResult[] {
  const before = new Map(previous.map((c) => [c.id, c.passRate]));
  return current.filter((c) => before.has(c.id) && c.passRate < before.get(c.id)!);
}

/** Refuses calls once `deadline` (epoch ms) passes, so a run always fits its time budget. */
export function withDeadline(ask: Ask, deadline: number): Ask {
  return (contract, prompt) =>
    Date.now() > deadline ? Promise.reject(new Error('time budget exhausted before this run')) : ask(contract, prompt);
}
