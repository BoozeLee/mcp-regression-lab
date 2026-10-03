import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  [key: string]: unknown;
};

export type Tool = {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
};

export type Contract = { server: string; takenAt: string; tools: Tool[] };

export type Severity = "breaking" | "changed" | "warning";

export type Change = {
  severity: Severity;
  kind: string;
  tool: string;
  detail: string;
};

// Deterministic key order so identical schemas always serialize identically.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

const stable = (value: unknown): string => JSON.stringify(sortKeys(value));

export function normalize(
  server: string,
  tools: Tool[],
  takenAt = new Date().toISOString(),
): Contract {
  const sorted = [...tools]
    .map(
      (t) =>
        sortKeys({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema,
        }) as Tool,
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return { server, takenAt, tools: sorted };
}

// Query strings can carry API keys, so only origin + path are recorded.
export function redactUrl(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

export async function snapshot(
  url: string,
  token?: string,
  timeoutMs = 15_000,
  fetchImpl?: typeof fetch,
): Promise<Contract> {
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error(`timed out after ${timeoutMs}ms`);
    return ms;
  };
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
    ...(fetchImpl && { fetch: fetchImpl }),
  });
  const client = new Client({ name: "mcp-regression-lab", version: "0.1.0" });
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    timer.unref();
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    clearTimeout(timer!);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, {
        timeout: remaining(),
      });
      tools.push(...(page.tools as Tool[]));
      if (tools.length > 1_000)
        throw new Error("server returned more than 1000 tools");
      cursor = page.nextCursor;
    } while (cursor);
    return normalize(redactUrl(url), tools);
  } catch (err) {
    const message = (err as Error).message;
    throw new Error(
      `snapshot of ${redactUrl(url)} failed: ${token ? message.split(token).join("***") : message}`,
    );
  } finally {
    clearTimeout(timer!);
    await client.close().catch(() => {});
  }
}

const typeOf = (s: JsonSchema | undefined): string => stable(s?.type ?? "any");

function diffSchemas(
  tool: string,
  before: JsonSchema,
  after: JsonSchema,
): Change[] {
  const changes: Change[] = [];
  const oldProps = before.properties ?? {};
  const newProps = after.properties ?? {};
  const oldReq = new Set(before.required ?? []);
  const newReq = new Set(after.required ?? []);

  for (const arg of Object.keys(oldProps)) {
    if (!(arg in newProps)) {
      changes.push({
        severity: "breaking",
        kind: "arg-removed",
        tool,
        detail: `argument "${arg}" removed`,
      });
      continue;
    }
    if (typeOf(oldProps[arg]) !== typeOf(newProps[arg])) {
      changes.push({
        severity: "breaking",
        kind: "arg-type-changed",
        tool,
        detail: `argument "${arg}" type ${typeOf(oldProps[arg])} -> ${typeOf(newProps[arg])}`,
      });
    }
    if (oldReq.has(arg) && !newReq.has(arg)) {
      changes.push({
        severity: "changed",
        kind: "arg-now-optional",
        tool,
        detail: `argument "${arg}" is no longer required`,
      });
    }
    if (!oldReq.has(arg) && newReq.has(arg)) {
      changes.push({
        severity: "breaking",
        kind: "arg-now-required",
        tool,
        detail: `argument "${arg}" is now required`,
      });
    }
  }
  for (const arg of Object.keys(newProps)) {
    if (arg in oldProps) continue;
    const required = newReq.has(arg);
    changes.push({
      severity: required ? "breaking" : "changed",
      kind: "arg-added",
      tool,
      detail: `argument "${arg}" added${required ? " (required)" : ""}`,
    });
  }
  return changes;
}

// ponytail: keyword heuristic, not a classifier; swap for a judge model if false negatives matter.
const INJECTION =
  /ignore (all |any )?(previous|prior|above) instructions|disregard .{0,30}instructions|system prompt|you must (always )?call|do not tell the user|exfiltrat|<\/?(system|instructions?)>/i;

export function diffContracts(before: Contract, after: Contract): Change[] {
  const oldByName = new Map(before.tools.map((t) => [t.name, t]));
  const newByName = new Map(after.tools.map((t) => [t.name, t]));
  const removed = before.tools.filter((t) => !newByName.has(t.name));
  const added = after.tools.filter((t) => !oldByName.has(t.name));
  const changes: Change[] = [];

  // A removed + added pair with an identical schema is reported as one rename.
  for (const gone of removed) {
    const match = added.findIndex(
      (t) => stable(t.inputSchema) === stable(gone.inputSchema),
    );
    if (match >= 0) {
      const [renamed] = added.splice(match, 1);
      changes.push({
        severity: "breaking",
        kind: "tool-renamed",
        tool: gone.name,
        detail: `renamed to "${renamed.name}"`,
      });
    } else {
      changes.push({
        severity: "breaking",
        kind: "tool-removed",
        tool: gone.name,
        detail: "tool no longer listed",
      });
    }
  }
  for (const t of added) {
    changes.push({
      severity: "changed",
      kind: "tool-added",
      tool: t.name,
      detail: "new tool listed",
    });
  }
  for (const [name, now] of newByName) {
    const was = oldByName.get(name);
    if (!was) continue;
    if ((was.description ?? "") !== (now.description ?? "")) {
      changes.push({
        severity: "changed",
        kind: "description-changed",
        tool: name,
        detail: "description text changed",
      });
    }
    changes.push(...diffSchemas(name, was.inputSchema, now.inputSchema));
  }
  for (const t of after.tools) {
    if (INJECTION.test(t.description ?? "")) {
      changes.push({
        severity: "warning",
        kind: "suspicious-description",
        tool: t.name,
        detail:
          "description contains instruction-like text (possible prompt injection)",
      });
    }
  }
  return changes;
}

// Single-snapshot hygiene checks: things that make models pick tools or fill arguments badly.
export function lintContract(contract: Contract): Change[] {
  const findings: Change[] = [];
  const add = (
    severity: Severity,
    kind: string,
    tool: string,
    detail: string,
  ) => findings.push({ severity, kind, tool, detail });
  for (const t of contract.tools) {
    if ((t.description ?? "").trim().length < 20)
      add(
        "warning",
        "thin-description",
        t.name,
        "tool description is missing or under 20 characters",
      );
    if (INJECTION.test(t.description ?? ""))
      add(
        "warning",
        "suspicious-description",
        t.name,
        "description contains instruction-like text (possible prompt injection)",
      );
    for (const [arg, schema] of Object.entries(
      t.inputSchema.properties ?? {},
    )) {
      if (
        schema.type === undefined &&
        !("anyOf" in schema) &&
        !("oneOf" in schema) &&
        !("$ref" in schema)
      ) {
        add("warning", "untyped-arg", t.name, `argument "${arg}" has no type`);
      }
      if (!schema.description)
        add(
          "changed",
          "undocumented-arg",
          t.name,
          `argument "${arg}" has no description`,
        );
    }
  }
  return findings;
}

/** Breaking changes in `current` that `previous` did not already report — what's worth an alert. */
export function newBreaking(previous: Change[], current: Change[]): Change[] {
  const key = (c: Change) => `${c.tool}\u0000${c.kind}\u0000${c.detail}`;
  const known = new Set(previous.filter((c) => c.severity === "breaking").map(key));
  return current.filter((c) => c.severity === "breaking" && !known.has(key(c)));
}
