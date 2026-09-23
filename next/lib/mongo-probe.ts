import net from "node:net";
import tls from "node:tls";
import { promises as dnsPromises } from "node:dns";

import { MongoClient } from "mongodb";

/**
 * Staged, credential-free MongoDB connectivity probe — diagnostics ONLY.
 *
 * When the credentialed driver ping fails we currently know only that *something*
 * between the Vercel runtime and Atlas refused. This probe repeats the journey
 * one stage at a time so the exact failing step becomes visible in /api/health
 * and in the Vercel logs:
 *
 *   1. srv  — can the runtime resolve Atlas `_mongodb._tcp` SRV records?
 *   2. tcp  — can it open a raw TCP socket to a shard endpoint?
 *   3. tls  — can it complete a TLS handshake on that socket?
 *   4. ping — does an *anonymous* driver ping get answered? (An
 *             "authentication required" reply still proves the network path.)
 *
 * Nothing here ever includes credentials in its output: error strings are
 * scrubbed through `scrub()`, and the anonymous ping uses a credential-stripped
 * copy of the URI that is never printed.
 */

const STAGE_TIMEOUT_MS = 4_000;
const PING_STAGE_TIMEOUT_MS = 6_000;

export interface ProbeStage {
  ok: boolean;
  detail: string;
  ms?: number;
  /** Endpoint used for tcp/tls, e.g. `cluster0-shard-00-00.x.mongodb.net:27017`. */
  endpoint?: string;
  /** Resolved SRV targets (public DNS data — safe to show, capped at 3). */
  srvTargets?: string[];
  /** A/AAAA records this runtime resolved for the dialled host (public data). */
  addresses?: string[];
  /** One line per dialled endpoint — shows whether *every* node failed. */
  attempts?: string[];
  skipped?: boolean;
}

export interface ConnectivityProbe {
  ran: boolean;
  srv?: ProbeStage;
  /** A/AAAA records for the shard endpoint that stage 2 dials. */
  dns?: ProbeStage;
  tcp?: ProbeStage;
  tls?: ProbeStage;
  ping?: ProbeStage;
  verdict: string;
}

/** Removes anything that looks like `user:password@` from a diagnostic string. */
function scrub(text: string): string {
  return text.replace(/[A-Za-z0-9+._-]+\s*:\s*[^@\s]+@/g, "[redacted]@");
}

function firstLine(text: string, max = 180): string {
  const line = scrub(String(text)).split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

interface ParsedTarget {
  isSrv: boolean;
  hostname: string;
  port: number;
  /** Same URI with the userinfo (username/password) removed — never logged. */
  anonymousUri: string;
  database: string;
}

function readRawUri(): string | null {
  let raw = process.env.MONGODB_URI?.trim();
  if (!raw) return null;
  // Same quote-stripping as lib/mongodb.ts readUri(): a Vercel paste that
  // keeps surrounding quotes must not break diagnostics either.
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1).trim();
  }
  return raw.length > 0 ? raw : null;
}

function parseMongoTarget(): ParsedTarget | null {
  const raw = readRawUri();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const isSrv = parsed.protocol.replace(":", "") === "mongodb+srv";
    const anonymous = new URL(raw);
    anonymous.username = "";
    anonymous.password = "";
    return {
      isSrv,
      hostname: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 27017,
      anonymousUri: anonymous.toString(),
      database: decodeURIComponent(parsed.pathname.replace(/^\//, "")) || "admin",
    };
  } catch {
    return null;
  }
}

async function withTimeout<T>(
    label: string,
    ms: number,
    run: () => Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Splits `host:port` (an SRV target or seed-list entry) into diallable parts. */
function splitEndpoint(endpoint: string, fallbackPort: number): { host: string; port: number } {
  const trimmed = endpoint.trim();
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > -1) {
    const port = Number(trimmed.slice(lastColon + 1));
    if (Number.isFinite(port) && port > 0) {
      return { host: trimmed.slice(0, lastColon), port };
    }
  }
  return { host: trimmed, port: fallbackPort };
}

/** Raw TCP connect (no TLS) to `endpoint`. Resolves true/false, never throws. */
function tryTcp(host: string, port: number): Promise<{ ok: boolean; detail: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ok: boolean, detail: string) => {
      socket.destroy();
      resolve({ ok, detail, ms: Date.now() - started });
    };
    socket.setTimeout(STAGE_TIMEOUT_MS, () => finish(false, `TCP connect timed out after ${STAGE_TIMEOUT_MS}ms`));
    socket.once("connect", () => finish(true, "TCP socket opened"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(false, `TCP connect failed: ${error.code ?? error.name}: ${firstLine(error.message)}`),
    );
  });
}

/**
 * A/AAAA lookup for the host the TCP stage will dial.
 *
 * A runtime whose resolver cannot see the Atlas shard names fails here, while a
 * runtime whose resolver is fine but whose egress IP is not allowed in Atlas
 * fails in stage 2 instead. Distinguishing the two matters: one is a DNS
 * problem inside the function runtime, the other is an Atlas Network Access
 * problem — and the previous ENOTFOUND report conflated them because it looked
 * up the SRV *parent* (`cluster0.x.mongodb.net`), which has no A record by
 * design and therefore fails even against a perfectly healthy Atlas cluster.
 */
async function tryResolve(host: string): Promise<ProbeStage> {
  const read = async (kind: "resolve4" | "resolve6"): Promise<string[]> => {
    try {
      return await withTimeout(`${kind} lookup`, STAGE_TIMEOUT_MS, () => dnsPromises[kind](host));
    } catch {
      return [];
    }
  };

  const [ipv4, ipv6] = await Promise.all([read("resolve4"), read("resolve6")]);
  const addresses = [...ipv4, ...ipv6];

  return {
    ok: addresses.length > 0,
    endpoint: host,
    addresses,
    detail:
      addresses.length > 0
        ? `${host} resolves to ${ipv4.length} IPv4 / ${ipv6.length} IPv6 record(s)` +
          ` (A: ${ipv4.join(", ") || "none"}; AAAA: ${ipv6.join(", ") || "none"})`
        : `${host} has no A/AAAA record from this runtime — the function's resolver cannot see Atlas`,
  };
}

/** TLS handshake on a fresh socket to `endpoint`. Resolves, never throws. */
function tryTls(
  host: string,
  port: number,
  override?: { maxVersion?: "TLSv1.2" | "TLSv1.3" },
): Promise<{ ok: boolean; detail: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = tls.connect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true,
      ...(override ?? {}),
    });
    const finish = (ok: boolean, detail: string) => {
      socket.destroy();
      resolve({ ok, detail, ms: Date.now() - started });
    };
    socket.setTimeout(STAGE_TIMEOUT_MS, () => finish(false, `TLS handshake timed out after ${STAGE_TIMEOUT_MS}ms`));
    socket.once("secureConnect", () =>
      finish(true, `TLS handshake ok (${socket.getProtocol() ?? "unknown protocol"})`),
    );
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(false, `TLS handshake failed: ${error.code ?? error.name}: ${firstLine(error.message)}`),
    );
  });
}

/**
 * Anonymous driver ping. Any *authentication* response still proves the whole
 * network path (DNS → TCP → TLS → wire protocol) is working.
 */
async function tryAnonymousPing(
  anonymousUri: string,
  database: string,
): Promise<ProbeStage> {
  const client = new MongoClient(anonymousUri, {
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
    socketTimeoutMS: 5_000,
    appName: "qurbanihat-health-probe",
  });
  try {
    await withTimeout("anonymous ping", PING_STAGE_TIMEOUT_MS, () =>
      client.db(database).command({ ping: 1 }),
    );
    return { ok: true, detail: "anonymous ping succeeded (server is fully reachable)" };
  } catch (error) {
    const err = error as { name?: string; message?: string; code?: number; codeName?: string };
    const message = `${err.name ?? ""} ${err.codeName ?? ""} ${err.message ?? ""}`;
    if (/\b(Unauthorized|AuthenticationFailed)\b|auth/i.test(message)) {
      return {
        ok: true,
        detail:
          "server answered with an authentication requirement — DNS, TCP and TLS all work; " +
          "a failing credentialed ping therefore points at the database user/URI, not the network",
      };
    }
    return { ok: false, detail: `anonymous ping failed: ${firstLine(err.message ?? String(error))}` };
  } finally {
    client.close(true).catch(() => {});
  }
}

/**
 * Turns the per-endpoint TCP attempts into an actionable verdict.
 *
 * The failure classes need different fixes, so they must not be collapsed into
 * "the firewall blocked us":
 *   - DNS failure     -> the function's resolver cannot see the shard names.
 *   - connect timeout -> packets are dropped: Atlas Network Access does not
 *                        allow this runtime's egress IP (Atlas drops silently,
 *                        which is exactly why a blocked IP looks like a hang).
 *   - refused/reset   -> something answered, but no MongoDB is listening there.
 */
function classifyTcpFailure(attempts: string[], dns?: ProbeStage): string {
  const joined = attempts.join(" | ");

  if (dns && !dns.ok) {
    return (
      `The Vercel runtime cannot resolve the Atlas shard hostname (${dns.detail}). ` +
      "This is a DNS failure inside the function runtime, not an Atlas allowlist block — " +
      "a blocked IP times out instead of failing DNS."
    );
  }

  if (/ENOTFOUND|EAI_AGAIN|ESERVFAIL|querySrv/i.test(joined)) {
    return (
      `The Vercel runtime cannot resolve the Atlas shard hostname(s) (${joined}). ` +
      "This is a DNS failure inside the function runtime, not an Atlas allowlist block — " +
      "a blocked IP times out instead of failing DNS."
    );
  }

  if (/timed out|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNREFUSED|ECONNRESET/i.test(joined)) {
    return (
      `The Vercel runtime cannot open a TCP socket to any Atlas shard endpoint (${joined}). ` +
      "Atlas silently drops traffic from IP addresses that are not in Network Access, so confirm " +
      "Atlas → Network Access contains 0.0.0.0/0 (or this deployment's egress IPs) for THIS " +
      "project's cluster, that the entry is not temporary/expired, and that the cluster is not paused."
    );
  }

  return `No Atlas shard endpoint accepted a TCP connection (${joined}).`;
}

/**
 * Explains a failed TLS stage.
 *
 * DNS, TCP and SNI all succeed in this stage's predecessor, so the handshake is
 * rejected by Atlas itself. MongoDB Atlas answers a *TLS alert* (not a dropped
 * packet) when the connecting IP is missing from its Network Access list — the
 * same `SSL alert number 80` signature that AWS ECS → Atlas users see — so the
 * fix belongs in Atlas, not in the Vercel configuration.
 */
function classifyTlsFailure(detail: string, endpoint: string): string {
  if (/alert internal error|SSL alert number 80|ERR_SSL_TLSV1_ALERT|handshake failure/i.test(detail)) {
    return (
      `Atlas accepted the TCP connection to ${endpoint} but refused the TLS handshake ` +
      `(SSL alert 80 = internal_error). Atlas returns this alert when the connecting IP address is ` +
      "not in its Network Access list, so add this deployment's egress IPs — or 0.0.0.0/0 for " +
      "Vercel's dynamic IPs — to Atlas → Network Access, wait about a minute for the change to " +
      "propagate, then reload this page."
    );
  }

  return (
    `TCP works but the TLS handshake with Atlas fails (${detail}). Verify the cluster is not paused ` +
    "and that its Atlas → Network Access list allows this deployment's egress IPs."
  );
}

/**
 * Runs the staged probe. Always resolves — a probe failure is data, not an
 * exception — and is safe to expose: no secrets are ever included.
 */
export async function runConnectivityProbe(): Promise<ConnectivityProbe> {
  const target = parseMongoTarget();
  if (!target) {
    return { ran: true, verdict: "MONGODB_URI is missing or unparsable — nothing to probe." };
  }

  const probe: ConnectivityProbe = { ran: true, verdict: "" };
  let endpoint = `${target.hostname}:${target.port}`;
  const srvTargets: string[] = [];

  // Stage 1 — SRV (only meaningful for mongodb+srv URIs).
  if (target.isSrv) {
    try {
      const records = await withTimeout("SRV lookup", STAGE_TIMEOUT_MS, () =>
        dnsPromises.resolveSrv(`_mongodb._tcp.${target.hostname}`),
      );
      probe.srv = {
        ok: records.length > 0,
        detail:
          records.length > 0
            ? `resolved ${records.length} SRV record(s) for _mongodb._tcp.${target.hostname}`
            : "SRV lookup returned no records",
        srvTargets: records.slice(0, 3).map((record) => `${record.name}:${record.port}`),
      };
      for (const record of records.slice(0, 3)) srvTargets.push(`${record.name}:${record.port}`);
      const first = records[0];
      if (first) endpoint = `${first.name}:${first.port}`;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      probe.srv = {
        ok: false,
        detail: `SRV lookup failed: ${err.code ?? err.name}: ${firstLine(err.message ?? String(error))}`,
      };
    }
  } else {
    probe.srv = { ok: true, skipped: true, detail: "URI is a standard seed-list (no SRV lookup needed)" };
    srvTargets.push(endpoint);
  }

  if (srvTargets.length === 0) srvTargets.push(endpoint);

  // Stage 2a — A/AAAA records for the endpoint stage 2b dials. Separating the
  // resolver from the socket proves whether a failure is DNS or networking.
  const firstDialTarget = srvTargets[0];
  probe.dns = await tryResolve(splitEndpoint(firstDialTarget, target.port).host);

  // Stage 2b — raw TCP against the REAL shard endpoints, never the SRV parent
  // name (`cluster0.x.mongodb.net` is SRV-only and has no A record by design, so
  // dialling it always fails with ENOTFOUND even when Atlas is perfectly
  // healthy). Every advertised shard is tried, so one dead node cannot produce a
  // false "the whole cluster is blocked" verdict.
  const attempts: string[] = [];
  let tcp = { ok: false, detail: "no endpoint to dial", ms: 0 };
  let tcpEndpoint = firstDialTarget;

  for (const candidate of srvTargets) {
    const { host, port } = splitEndpoint(candidate, target.port);
    const result = await tryTcp(host, port);
    attempts.push(`${candidate} -> ${result.detail} (${result.ms}ms)`);
    tcpEndpoint = candidate;
    tcp = result;
    if (result.ok) break;
  }

  probe.tcp = { ok: tcp.ok, detail: tcp.detail, ms: tcp.ms, endpoint: tcpEndpoint, attempts };
  if (!tcp.ok) {
    probe.tls = { ok: false, skipped: true, detail: "skipped (TCP failed)" };
    probe.ping = { ok: false, skipped: true, detail: "skipped (TCP failed)" };
    probe.verdict = classifyTcpFailure(attempts, probe.dns);
    return probe;
  }

  // Stage 3 — TLS against the same shard endpoint. If the default handshake is
  // refused, retry pinned to TLS 1.2: a refusal that only affects TLS 1.3 is a
  // protocol problem the app can work around, while a refusal on *both* means
  // the peer is rejecting the connection itself (Atlas Network Access).
  const { host: tlsHost, port: tlsPort } = splitEndpoint(tcpEndpoint, target.port);
  const tlsResult = await tryTls(tlsHost, tlsPort);
  const tlsAttempts = [`default (TLS 1.3 offered): ${tlsResult.detail}`];
  let tlsOk = tlsResult.ok;

  if (!tlsResult.ok) {
    const legacy = await tryTls(tlsHost, tlsPort, { maxVersion: "TLSv1.2" });
    tlsAttempts.push(`maxVersion=TLSv1.2: ${legacy.detail}`);
    tlsOk = legacy.ok;
  }

  probe.tls = {
    ok: tlsOk,
    detail: tlsResult.ok ? tlsResult.detail : tlsAttempts.join(" | "),
    ms: tlsResult.ms,
    endpoint: tcpEndpoint,
    attempts: tlsAttempts,
  };

  if (!tlsOk) {
    probe.ping = { ok: false, skipped: true, detail: "skipped (TLS failed)" };
    probe.verdict =
      classifyTlsFailure(tlsResult.detail, tcpEndpoint) +
      " Both the default handshake and a TLS 1.2-only handshake were refused, so this is not a " +
      "protocol-version problem.";
    return probe;
  }

  if (!tlsResult.ok) {
    // TLS 1.2 completes but the runtime's preferred handshake does not: pin the
    // runtime to TLS 1.2 and redeploy.
    probe.ping = { ok: false, skipped: true, detail: "skipped (TLS 1.2 fallback only)" };
    probe.verdict =
      `The TLS handshake to ${tcpEndpoint} is only accepted with TLS 1.2 — the runtime's TLS 1.3 ` +
      "handshake is refused by Atlas. Set NODE_OPTIONS=--tls-max-v1.2 for this deployment (Vercel → " +
      "Settings → Environment Variables) and redeploy.";
    return probe;
  }

  // Stage 4 — anonymous ping.
  probe.ping = await tryAnonymousPing(target.anonymousUri, target.database);
  probe.verdict = probe.ping.ok
    ? "Network path to Atlas is fully working end-to-end from this runtime."
    : "TLS works but the server never answered the wire-protocol ping — unusual; inspect Atlas cluster status.";
  return probe;
}
