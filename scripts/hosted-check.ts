// Runs a hosted check for CI and writes diff.json / lint.json in the same shape as
// the local CLI, so the PR comment step is shared. Never exits non-zero itself:
// the action fails the job in its last step, after the PR comment is posted.
// Env: HOSTED_URL, API_TOKEN, SERVER_ID, GITHUB_OUTPUT (optional).
import { appendFileSync, writeFileSync } from "node:fs";

const { HOSTED_URL, API_TOKEN, SERVER_ID, GITHUB_OUTPUT } = process.env;
const output = (key: string, value: string | number | boolean) => {
  console.log(`${key}=${value}`);
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `${key}=${value}\n`);
};

type Change = { severity: string; tool: string; kind: string; detail: string };
type Result = {
  ok: boolean;
  status: string;
  error: string | null;
  breaking: Change[];
  changes: Change[];
  lint: Change[];
  golden: {
    passRate: number | null;
    error: string | null;
    regressions: { prompt: string; expectTool: string; passRate: number }[];
  } | null;
  dashboardUrl: string;
};

async function main() {
  if (!HOSTED_URL || !API_TOKEN || !SERVER_ID)
    throw new Error("HOSTED_URL, API_TOKEN and SERVER_ID are required");
  const res = await fetch(
    `${HOSTED_URL.replace(/\/+$/, "")}/api/v1/servers/${encodeURIComponent(SERVER_ID)}/checks`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${API_TOKEN}` },
      signal: AbortSignal.timeout(310_000),
    },
  );
  const body = (await res.json().catch(() => ({}))) as Result & {
    error?: string;
  };
  if (!res.ok)
    throw new Error(
      `hosted check failed (${res.status}): ${body.error ?? "no details"}`,
    );

  const findings = [...body.changes];
  if (body.error)
    findings.push({
      severity: "breaking",
      kind: "check-failed",
      tool: SERVER_ID,
      detail: body.error,
    });
  if (body.golden?.error)
    findings.push({
      severity: "breaking",
      kind: "golden-run-failed",
      tool: SERVER_ID,
      detail: body.golden.error,
    });
  for (const regression of body.golden?.regressions ?? [])
    findings.push({
      severity: "breaking",
      kind: "golden-regression",
      tool: regression.expectTool,
      detail: `pass rate fell to ${Math.round(regression.passRate * 100)}% for prompt "${regression.prompt}"`,
    });
  writeFileSync("diff.json", JSON.stringify(findings, null, 2));
  writeFileSync("lint.json", JSON.stringify(body.lint, null, 2));
  output("ok", body.ok);
  output("status", body.status);
  output("breaking", body.breaking.length);
  output("golden-regressions", body.golden?.regressions.length ?? 0);
  if (body.error) console.log(`server check error: ${body.error}`);
  if (body.golden?.error) console.log(`golden tests could not run: ${body.golden.error}`);
  for (const r of body.golden?.regressions ?? [])
    console.log(
      `golden regression: "${r.prompt}" → ${r.expectTool} now ${Math.round(r.passRate * 100)}%`,
    );
  console.log(`details: ${body.dashboardUrl}`);
}

main().catch((err) => {
  const message = (err as Error).message;
  console.error(message);
  // A check that couldn't run is not a pass.
  output("ok", false);
  output("status", "error");
  writeFileSync(
    "diff.json",
    JSON.stringify(
      [
        {
          severity: "breaking",
          kind: "check-failed",
          tool: SERVER_ID ?? "unknown-server",
          detail: message,
        },
      ],
      null,
      2,
    ),
  );
  writeFileSync("lint.json", "[]");
});
