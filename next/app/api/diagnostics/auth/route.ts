import { NextResponse } from "next/server";

import { resolveServerBaseUrl } from "@/lib/app-url";
import { isGoogleProviderConfigured } from "@/lib/auth-flags";
import { getDatabaseStatus, maskMongoTarget } from "@/lib/mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED_ENV_VARS = [
  "MONGODB_URI",
  "MONGODB_DB",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "NEXT_PUBLIC_BETTER_AUTH_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const;

function envSummary() {
  return REQUIRED_ENV_VARS.map((name) => ({
    name,
    configured: Boolean(process.env[name]?.trim()),
  }));
}

function classifyMongoPing(status: Awaited<ReturnType<typeof getDatabaseStatus>>) {
  return {
    configured: status.configured,
    reachable: status.reachable,
    kind: status.kind,
    target: status.target,
    database: status.database,
    detail: status.detail,
    /** Redacted driver text behind `detail` — the raw evidence. */
    raw: status.raw,
  };
}

export async function GET(request: Request) {
  const providedToken = request.headers.get("x-diagnostics-token") || request.headers.get("DIAGNOSTICS_TOKEN");
  const expectedToken = process.env.DIAGNOSTICS_TOKEN?.trim();

  if (expectedToken && (!providedToken || providedToken !== expectedToken)) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const database = await getDatabaseStatus(true);
  const baseUrl = resolveServerBaseUrl() ?? "http://localhost:3000";
  const googleCallback = `${baseUrl.replace(/\/+$/, "")}/api/auth/callback/google`;

  return NextResponse.json(
    {
      ok: database.reachable && Boolean(process.env.BETTER_AUTH_SECRET?.trim()) && isGoogleProviderConfigured,
      requiredEnvVars: envSummary(),
      mongo: classifyMongoPing(database),
      google: {
        configured: isGoogleProviderConfigured,
        expectedCallbackUrl: googleCallback,
      },
      app: {
        baseUrl,
        target: maskMongoTarget(),
      },
      timestamp: new Date().toISOString(),
    },
    { status: database.reachable ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
