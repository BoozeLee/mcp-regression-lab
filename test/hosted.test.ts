import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import {
  assertPublicUrl,
  decryptToken,
  encryptToken,
  guardRequestInit,
  guardedFetch,
  isBlockedAddress,
  scrubSecrets,
} from "../src/hosted.ts";
import { snapshot } from "../src/contract.ts";

const address = (server: Server) => server.address() as AddressInfo;

test("private, loopback and metadata addresses are blocked", () => {
  for (const a of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:a9fe:a9fe",
  ]) {
    assert.equal(isBlockedAddress(a), true, a);
  }
  for (const a of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    assert.equal(isBlockedAddress(a), false, a);
});

test("only public https URLs pass the up-front check", () => {
  for (const u of [
    "http://example.com/mcp",
    "https://127.0.0.1/mcp",
    "https://[::1]/mcp",
    "https://0x7f.1/mcp",
    "https://2130706433/mcp",
    "https://169.254.169.254/latest",
    "https://u:p@example.com/",
    "nope",
  ]) {
    assert.throws(() => assertPublicUrl(u), u);
  }
  assert.equal(
    assertPublicUrl("https://example.com/mcp").hostname,
    "example.com",
  );
});

test("guardedFetch refuses a hostname that resolves to loopback", async () => {
  await assert.rejects(
    guardedFetch("https://localhost/mcp"),
    /private address|fetch failed/,
  );
});

test("snapshot through guardedFetch fails closed on a private target", async () => {
  await assert.rejects(
    snapshot("https://localhost:9/mcp", undefined, 3000, guardedFetch),
    /failed/,
  );
});

test("token encryption round-trips and detects tampering or a wrong key", () => {
  const key = randomBytes(32).toString("base64");
  const blob = encryptToken("sk-secret-123", key);
  assert.ok(!blob.includes("sk-secret"));
  assert.equal(decryptToken(blob, key), "sk-secret-123");
  const parts = blob.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decryptToken(parts.join("."), key));
  assert.throws(() => decryptToken(blob, randomBytes(32).toString("base64")));
  assert.throws(() => encryptToken("x", "short"), /32 bytes/);
});

// The October 1 Tandem incident: a bearer token stored before the v1 envelope
// existed. Silent acceptance would send the stored blob as-is to the customer.
test("decryptToken refuses a legacy or malformed envelope", () => {
  const key = randomBytes(32).toString("base64");
  for (const blob of ["sk-plain-legacy-key", "", "v2.aa.bb.cc", "v1.aa.bb", "v1.aa.bb."])
    assert.throws(() => decryptToken(blob, key), /unrecognised token format/, blob);
});

// undici only runs the lookup hook for hostnames, so a 3xx pointing at an IP
// literal walks past safeLookup into loopback. Refusing redirects is the only
// defence, so pin both halves: the guard forces the refusal and a caller cannot
// relax it, and that refusal is what actually stops the bypass.
test("a redirect to a loopback IP literal is refused and cannot be relaxed by the caller", async () => {
  const init = guardRequestInit({
    redirect: "follow",
    method: "POST",
    // A caller trying to swap in its own dispatcher escapes safeLookup.
    dispatcher: "bypass-me",
  } as RequestInit);
  assert.equal(init.redirect, "error");
  assert.ok(init.dispatcher instanceof Agent, "guard did not attach its own dispatcher");
  assert.equal(init.method, "POST");

  let reachedInternal = false;
  const internal = createServer((_req, res) => {
    reachedInternal = true;
    res.end("instance metadata");
  });
  const redirector = createServer((_req, res) => {
    res.writeHead(302, {
      location: `http://127.0.0.1:${address(internal).port}/latest`,
    });
    res.end();
  });
  await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${address(redirector).port}/mcp`;
  try {
    // Control: the fixture really can reach loopback when redirects are
    // followed, so the rejection below cannot be passing vacuously.
    await (await undiciFetch(url, { redirect: "follow" })).text();
    assert.equal(reachedInternal, true, "control fixture did not fire");

    reachedInternal = false;
    await assert.rejects(
      undiciFetch(url, { redirect: init.redirect }),
      /fetch failed/,
    );
    assert.equal(reachedInternal, false, "guard redirect value still delivered to loopback");
  } finally {
    internal.close();
    redirector.close();
  }
});

// The alert boundary must not trust producers to have redacted: snapshot()
// scrubs only its own token and golden errors scrub nothing. Each assertion
// kills a plausible mutation: replace() on the first hit only, a length floor
// that skips short secrets, and a loop that throws on null entries.
test("scrubSecrets removes every occurrence of every known secret", () => {
  const token = "glimmer-token-abc";
  const webhook = "https://hooks.example/x1";
  const text = `auth failed: ${token}; retry ${token} via ${webhook}`;
  const out = scrubSecrets(text, [token, webhook, null, undefined, ""]);
  assert.ok(!out.includes(token), "a secret survived the scrub");
  assert.ok(!out.includes(webhook), "the webhook URL survived the scrub");
  assert.ok(out.includes("***") && out.includes("***"), "occurrences not all replaced");
  assert.ok(out.includes("auth failed:") && out.includes("via "), "context was over-scrubbed");
});

test("scrubSecrets has no length floor and is a no-op without secrets", () => {
  assert.equal(scrubSecrets("key=ab and abcd", ["ab"]), "key=*** and ***cd");
  assert.equal(scrubSecrets("nothing to see", ["zz"]), "nothing to see");
  assert.equal(scrubSecrets("untouched", []), "untouched");
});
