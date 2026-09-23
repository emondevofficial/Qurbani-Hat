/**
 * Single source of truth for every browser-facing URL in QurbaniHat.
 *
 * Why this file exists
 * --------------------
 * The Next.js server must be free to bind to `0.0.0.0` (all interfaces) so
 * containers, LAN devices and preview tunnels can reach it. A browser, however,
 * can never navigate to `0.0.0.0` — Chrome reports `ERR_ADDRESS_INVALID (-108)`.
 *
 * Every URL that ends up in the browser (metadata, OAuth redirects, the Better
 * Auth client base URL, trusted origins) is therefore passed through
 * `normalizeBrowsableUrl()`, which rewrites socket-only hosts such as
 * `0.0.0.0`, `::` and `127.0.0.1` to `localhost` while preserving the port.
 *
 * Production safety
 * -----------------
 * `NEXT_PUBLIC_*` values are inlined at build time, and a `.env.local` copied
 * straight into a hosting dashboard is the classic way to break a deployment.
 * A loopback value can therefore NEVER win on a hosted runtime:
 *   - `resolveServerBaseUrl()` ignores `http://localhost:...` and uses the
 *     deployment's own origin instead, so the OAuth `redirect_uri` sent to
 *     Google always matches the live domain;
 *   - `resolveBrowserBaseUrl()` returns `undefined` for such a value, letting
 *     the Better Auth client infer the correct `window.location.origin`.
 */

/** Local development fallback (the port used by `npm run dev`). */
export const DEFAULT_DEV_URL = "http://localhost:3000";

/** Hosts that exist for socket binding only and are never valid to navigate to. */
const BIND_ONLY_HOSTNAMES = new Set(["0.0.0.0", "::", "[::]", "127.0.0.1"]);

/** Every hostname that only makes sense on the machine running the server. */
const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  ...BIND_ONLY_HOSTNAMES,
]);

let hasWarned = false;

/**
 * Deployment warnings go to the server console (Vercel → Deployments →
 * Functions → Logs). They are always emitted, including in production, because
 * a misconfigured base URL is otherwise completely silent.
 */
function warnOnce(message: string) {
  if (hasWarned) return;
  hasWarned = true;
  console.warn(`[QurbaniHat] ${message}`);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/** True when the app is running on Vercel (or any configured hosted runtime). */
export function isHostedRuntime(): boolean {
  return Boolean(
    process.env.VERCEL ||
      process.env.VERCEL_ENV ||
      process.env.VERCEL_URL ||
      process.env.VERCEL_PROJECT_PRODUCTION_URL,
  );
}

/**
 * Returns a URL that is safe to open in a browser, or `undefined` when the
 * input is missing/invalid. `http://0.0.0.0:3000` becomes
 * `http://localhost:3000`.
 */
export function normalizeBrowsableUrl(raw?: string | null): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    warnOnce(`Ignoring invalid URL "${value}" — expected something like http://localhost:3000.`);
    return undefined;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    warnOnce(`Ignoring unsupported URL protocol in "${value}" — use http or https.`);
    return undefined;
  }

  if (BIND_ONLY_HOSTNAMES.has(parsed.hostname)) {
    const original = parsed.hostname;
    parsed.hostname = "localhost";
    warnOnce(
      `Rewrote "${value}" to "${parsed.toString()}" — "${original}" is a bind-only address ` +
        `and browsers cannot open it. Use http://localhost:${parsed.port || "3000"} in the browser.`,
    );
  }

  return stripTrailingSlash(parsed.toString());
}

/** True when the URL points at the machine running the server. */
function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** Vercel injects hostnames without a protocol. */
function toHttpsOrigin(value?: string): string | undefined {
  const host = value?.trim();
  if (!host) return undefined;
  if (host.startsWith("http://") || host.startsWith("https://")) {
    return stripTrailingSlash(host);
  }
  return `https://${host}`;
}

/**
 * The origin of this deployment as Vercel reports it.
 *
 * `VERCEL_URL` is the hostname of the deployment currently serving the
 * request, so previews keep their OAuth callback on their own domain, while a
 * production deployment always advertises its stable production domain.
 */
function vercelOrigin(): string | undefined {
  const preview = toHttpsOrigin(process.env.VERCEL_URL);
  const production = toHttpsOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL);

  if (process.env.VERCEL_ENV === "production") return production ?? preview;
  return preview ?? production;
}

/**
 * Base URL for server-side auth decisions (OAuth `redirect_uri`, trusted
 * origins, metadata). Returns `undefined` when nothing is configured, in which
 * case Better Auth falls back to the origin of the incoming request — the
 * safest behaviour for an unrecognised environment.
 *
 * On a hosted runtime the deployment's own origin is authoritative and any
 * loopback candidate is skipped: a copied `BETTER_AUTH_URL=http://localhost:3000`
 * would otherwise be sent to Google and rejected with `redirect_uri_mismatch`.
 */
export function resolveServerBaseUrl(): string | undefined {
  const hosted = isHostedRuntime();

  const candidates: (string | undefined)[] = hosted
    ? [
        vercelOrigin(),
        process.env.BETTER_AUTH_URL,
        process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
        process.env.NEXT_PUBLIC_APP_URL,
      ]
    : [
        process.env.BETTER_AUTH_URL,
        process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
        process.env.NEXT_PUBLIC_APP_URL,
        vercelOrigin(),
      ];

  for (const candidate of candidates) {
    const normalized = normalizeBrowsableUrl(candidate);
    if (!normalized) continue;

    if (hosted && isLoopbackUrl(normalized)) {
      warnOnce(
        `Ignoring "${normalized}" as the app base URL — this deployment is hosted, so a ` +
          `loopback address cannot be reached by a browser. Using the deployment origin instead.`,
      );
      continue;
    }

    return normalized;
  }

  return undefined;
}

/** Base URL used for metadata, canonical links and Open Graph tags. */
export function resolvePublicBaseUrl(): string {
  return resolveServerBaseUrl() ?? DEFAULT_DEV_URL;
}

/**
 * Base URL for the browser-side Better Auth client.
 *
 * Returning `undefined` lets the client infer `window.location.origin`, so a
 * deployment can never be pointed at the wrong host by a stale env value.
 * A `NEXT_PUBLIC_APP_URL` that was inlined as a loopback address at build time
 * is discarded when the page is not itself served from loopback.
 */
export function resolveBrowserBaseUrl(): string | undefined {
  const publicBaseUrl =
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL?.trim() ||
    process.env.NEXT_PUBLIC_APP_URL?.trim();

  const normalized = normalizeBrowsableUrl(publicBaseUrl);
  if (!normalized) return undefined;

  if (typeof window !== "undefined" && isLoopbackUrl(normalized)) {
    const servedFrom = window.location.hostname;
    if (!isLoopbackHostname(servedFrom)) {
      console.warn(
        `[QurbaniHat] NEXT_PUBLIC_APP_URL="${normalized}" points at a loopback address but this ` +
          `page is served from "${servedFrom}". Using window.location.origin instead.`,
      );
      return undefined;
    }
  }

  return normalized;
}

/**
 * Origins allowed to call `/api/auth/*` (CSRF protection).
 * Always includes the resolved public origin. Loopback pairs are only trusted
 * while the app is genuinely served from a local machine — on a hosted
 * deployment they would needlessly widen the allow-list.
 *
 * Vercel preview deployments live on a random subdomain (`<hash>.vercel.app`),
 * so the per-deployment VERCEL_URL and the project production domain are
 * always trusted as well — otherwise OAuth callbacks would fail the origin
 * check on every preview URL.
 */
export function buildTrustedOrigins(): string[] {
  const resolved = resolveServerBaseUrl();
  const origins = new Set<string>();

  if (resolved) {
    origins.add(resolved);
    try {
      const parsed = new URL(resolved);
      if (parsed.hostname === "localhost") {
        origins.add(`${parsed.protocol}//127.0.0.1${parsed.port ? `:${parsed.port}` : ""}`);
      }
    } catch {
      /* resolved is already validated, ignore */
    }
  }

  for (const candidate of [
    process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ]) {
    const normalized = normalizeBrowsableUrl(candidate);
    if (normalized) origins.add(normalized);
  }

  const production = toHttpsOrigin(process.env.VERCEL_PROJECT_PRODUCTION_URL);
  if (production) origins.add(production);

  const preview = toHttpsOrigin(process.env.VERCEL_URL);
  if (preview) origins.add(preview);

  // Path A — an origin for the real deployment was found: loopback is not needed.
  const hasHostedOrigin = Array.from(origins).some((origin) => !isLoopbackUrl(origin));
  if (!hasHostedOrigin) {
    // Path B — no hosted origin could be resolved, so keep local development
    // working (never return an empty allow-list, which would reject every
    // cross-origin auth request).
    origins.add(DEFAULT_DEV_URL);
    origins.add("http://127.0.0.1:3000");
  }

  return Array.from(origins);
}
