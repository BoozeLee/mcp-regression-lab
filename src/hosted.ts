// Safety layer for the hosted service: customers submit arbitrary URLs that our
// servers fetch (SSRF), and their bearer tokens must survive at rest.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Agent, type Dispatcher, fetch as undiciFetch } from "undici";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

/** True for loopback, private, link-local (cloud metadata) and other non-public addresses. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  // BlockList matches IPv4-mapped IPv6 (::ffff:127.0.0.1) against the IPv4 rules.
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Rejects anything but https to a host that isn't a private IP literal. */
export function assertPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("not a valid URL");
  }
  if (url.protocol !== "https:")
    throw new Error("only https:// endpoints are supported");
  if (url.username || url.password)
    throw new Error(
      "credentials in the URL are not allowed; use the token field",
    );
  // Node skips the lookup hook for IP literals, so those are checked here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedAddress(host))
    throw new Error(`refusing private address ${host}`);
  return url;
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

// Validates the address the socket actually connects to, so DNS rebinding
// between a check and the connect can't slip a private IP through.
function safeLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  cb: LookupCb,
) {
  dnsLookup(
    hostname,
    { family: options.family ?? 0, all: true },
    (err, addrs) => {
      if (err) return cb(err, "");
      const bad = addrs.find((a) => isBlockedAddress(a.address));
      if (bad)
        return cb(
          new Error(`refusing private address ${bad.address} for ${hostname}`),
          "",
        );
      if (options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    },
  );
}

const agent = new Agent({ connect: { lookup: safeLookup as never } });

/** The forced undici options, with the guard's own dispatcher attached. */
export type GuardedRequestInit = RequestInit & { dispatcher: Dispatcher };

/**
 * The undici options the guard always forces, last so a caller cannot relax
 * them. `redirect: "error"` is load-bearing: undici skips the lookup hook for
 * IP literals, so a 3xx to `https://127.0.0.1/` would bypass safeLookup.
 */
export function guardRequestInit(init?: RequestInit): GuardedRequestInit {
  return {
    ...(init as object),
    dispatcher: agent,
    redirect: "error",
  } as GuardedRequestInit;
}

/** fetch for customer-supplied endpoints: public https only, no redirects. */
export const guardedFetch = ((
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url =
    typeof input === "string" || input instanceof URL
      ? String(input)
      : input.url;
  assertPublicUrl(url);
  return undiciFetch(url, guardRequestInit(init) as never);
}) as unknown as typeof fetch;

/**
 * Removes every secret the caller knows about from text that is about to leave
 * the process (a webhook body, an error log). Producers redact inconsistently —
 * snapshot() scrubs the MCP token, golden errors scrub nothing — so the boundary
 * must not depend on them. No length floor: skipping a short secret would leak it.
 */
export function scrubSecrets(
  text: string,
  secrets: readonly (string | null | undefined)[],
): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join("***");
  return out;
}

function keyFrom(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32)
    throw new Error("TOKEN_KEY must be 32 bytes, base64-encoded");
  return key;
}

/** AES-256-GCM; output "v1.<iv>.<tag>.<ciphertext>" in base64url. */
export function encryptToken(plain: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(keyB64), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), ct]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

export function decryptToken(blob: string, keyB64: string): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !ct)
    throw new Error("unrecognised token format");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    keyFrom(keyB64),
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ct, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
