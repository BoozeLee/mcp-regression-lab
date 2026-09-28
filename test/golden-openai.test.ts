import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { normalize } from "../src/contract.ts";
import { goldenRegressions, openAICompatibleAsk, runGolden, withDeadline } from "../src/golden.ts";

const contract = normalize("https://x.test/mcp", [
  {
    name: "orders.refund",
    description: "Refund an order",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
  },
  { name: "search", description: "Search", inputSchema: {} },
]);

// Minimal stand-in for an OpenAI-compatible /chat/completions endpoint.
async function fakeLLM(
  reply: (
    body: any,
    headers: Record<string, unknown>,
  ) => { status?: number; json: unknown },
) {
  const seen: { body: any; headers: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      seen.push({ body, headers: req.headers });
      const r = reply(body, req.headers);
      res
        .writeHead(r.status ?? 200, { "content-type": "application/json" })
        .end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    url,
    seen,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

test("openAICompatibleAsk maps unsafe tool names both ways and sends the key", async () => {
  const llm = await fakeLLM((body) => ({
    json: {
      choices: [
        {
          message: {
            tool_calls: [
              {
                type: "function",
                function: {
                  name: body.tools[0].function.name,
                  arguments: '{"id":"42"}',
                },
              },
            ],
          },
        },
      ],
    },
  }));
  try {
    const calls = await openAICompatibleAsk(
      llm.url,
      "m",
      "sk-test",
    )(contract, "refund 42");
    assert.deepEqual(calls, [{ name: "orders.refund", args: { id: "42" } }]);
    const { body, headers } = llm.seen[0];
    assert.equal(headers.authorization, "Bearer sk-test");
    assert.equal(body.model, "m");
    assert.match(body.tools[0].function.name, /^[a-zA-Z0-9_-]{1,64}$/);
    // A schema without a type is still sent as an object schema.
    assert.equal(body.tools[1].function.parameters.type, "object");
  } finally {
    await llm.close();
  }
});

test("openAICompatibleAsk surfaces HTTP errors without echoing the key", async () => {
  const llm = await fakeLLM(() => ({
    status: 401,
    json: { error: { message: "bad key sk-test" } },
  }));
  try {
    await assert.rejects(
      openAICompatibleAsk(llm.url, "m", "sk-test")(contract, "x"),
      (err: Error) => {
        assert.match(err.message, /401/);
        assert.ok(!err.message.includes("sk-test"));
        return true;
      },
    );
  } finally {
    await llm.close();
  }
});

test("runGolden with concurrency keeps case order and bounds in-flight calls", async () => {
  let inFlight = 0;
  let peak = 0;
  const ask = async (_c: unknown, prompt: string) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return [{ name: prompt, args: {} }];
  };
  const cases = ["search", "orders.refund", "search"].map((t, i) => ({
    id: `c${i}`,
    prompt: t,
    expectTool: t,
  }));
  const r = await runGolden(contract, cases, ask, "fake", 3, 2);
  assert.deepEqual(
    r.cases.map((c) => c.id),
    ["c0", "c1", "c2"],
  );
  assert.ok(r.cases.every((c) => c.passRate === 1 && c.runs.length === 3));
  assert.ok(peak <= 2, `peak ${peak}`);
});

test('goldenRegressions flags cases whose pass rate dropped, ignoring new cases', () => {
  const r = (id: string, passRate: number) => ({ id, expectTool: 't', passRate, runs: [] });
  const prev = [r('a', 1), r('b', 2 / 3), r('c', 1)];
  const curr = [r('a', 1), r('b', 1 / 3), r('c', 1), r('new', 0)];
  assert.deepEqual(goldenRegressions(prev, curr).map((x) => x.id), ['b']);
});

test('withDeadline fails calls after the deadline instead of hanging', async () => {
  const slowAsk = async () => [{ name: 'search', args: {} }];
  const ask = withDeadline(slowAsk, Date.now() - 1);
  await assert.rejects(ask(contract, 'p'), /time budget/);
});
