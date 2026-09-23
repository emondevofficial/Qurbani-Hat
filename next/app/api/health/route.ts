import { NextResponse } from "next/server";

import { resolvePublicBaseUrl, resolveServerBaseUrl } from "@/lib/app-url";
import { isGoogleProviderConfigured } from "@/lib/auth-flags";
import { runConnectivityProbe, type ConnectivityProbe } from "@/lib/mongo-probe";
import { getDatabaseStatus } from "@/lib/mongodb";

/**
 * Deployment diagnostics for the auth stack — contains NO secrets.
 *
 * Visit `/api/health` on any deployment to see, in one request, exactly which
 * part of the sign-in chain is broken:
 *
 *   mongodb.reachable  false -> every auth endpoint 500s before Google is ever
 *                               contacted. Fix MONGODB_URI (Vercel → Settings →
 *                               Environment Variables) and/or allow the
 *                               deployment's IP in Atlas → Network Access.
 *   google.expectedRedirectUri -> the exact value Better Auth sends to Google.
 *                               It must be registered verbatim in Google Cloud
 *                               Console → Credentials → OAuth 2.0 Client ID →
 *                               Authorized redirect URIs, otherwise Google
 *                               answers `redirect_uri_mismatch`.
 *
 * `detail` strings are produced by lib/mongodb.ts and are stripped of any
 * credentials, so this endpoint is safe to open in a browser.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The staged probe can take a few seconds when the database is unreachable. */
export const maxDuration = 30;

/** Better Auth's Google callback path (must match the Google console entry). */
const GOOGLE_CALLBACK_PATH = "/api/auth/callback/google";

/**
 * Commit this deployment was built from (Vercel injects VERCEL_GIT_COMMIT_SHA;
 * falls back to "local" for `next dev` / `next build` on a workstation).
 * Lets /api/health prove whether production is actually running the latest
 * commit instead of guessing from probe message text.
 */
const BUILD_SHA = (process.env.VERCEL_GIT_COMMIT_SHA || "local").slice(0, 12);

export async function GET() {
  try {
    const database = await getDatabaseStatus(true);
    const baseUrl = resolveServerBaseUrl() ?? resolvePublicBaseUrl();
    const secretConfigured = Boolean(process.env.BETTER_AUTH_SECRET?.trim());

    // When the credentialed ping fails, find out *which stage* of the network
    // journey fails (DNS SRV → TCP → TLS → wire protocol). Pure diagnostics:
    // credential-free and only computed when MongoDB is not reachable.
    let probe: ConnectivityProbe | undefined;
    if (!database.reachable) {
      try {
        const result = await runConnectivityProbe();
        probe = result;
        console.warn(
          `[QurbaniHat] MongoDB probe for ${database.target}: ` +
            `srv=${result.srv?.ok ?? "?"} dns=${result.dns?.ok ?? "?"} ` +
            `tcp=${result.tcp?.ok ?? "?"} tls=${result.tls?.ok ?? "?"} ` +
            `ping=${result.ping?.ok ?? "?"} — ${result.verdict}`,
        );
      } catch (probeError) {
        console.error("[QurbaniHat] MongoDB connectivity probe crashed:", probeError);
        probe = { ran: false, verdict: "The staged connectivity probe itself failed — check server logs." };
      }
    }

    const checks = {
      mongodb: {
        configured: database.configured,
        reachable: database.reachable,
        kind: database.kind,
        // Credential-free identification of the target this deployment is
        // pointed at, e.g. `cluster0.m2wttjg.mongodb.net/Qurbani-Hat`. Compare it
        // with the cluster shown in Atlas; a mismatch means the MONGODB_URI set
        // on the hosting dashboard is not the one you think it is.
        target: database.target,
        db: database.database,
        detail: database.detail,
        // Redacted driver text behind `detail` — the raw evidence (a timeout, a
        // DNS failure and an auth rejection all used to look identical).
        raw: database.raw,
        // Staged network diagnosis — present only when reachable is false.
        probe,
      },
      betterAuth: {
        secretConfigured,
        baseUrl,
      },
      google: {
        credentialsConfigured: isGoogleProviderConfigured,
        expectedRedirectUri: `${baseUrl}${GOOGLE_CALLBACK_PATH}`,
      },
    };

    const ok = database.reachable && secretConfigured;

    return NextResponse.json(
      { ok, buildSha: BUILD_SHA, checks, timestamp: new Date().toISOString() },
      { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[QurbaniHat] /api/health failed:", error);
    return NextResponse.json(
      {
        ok: false,
        checks: null,
        message: "The diagnostics endpoint could not complete. Check the server logs.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
