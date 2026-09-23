import { getDatabaseStatus } from "@/lib/mongodb";

/**
 * Turns a silent, bodyless "database is down" 500 into an explicit diagnosis.
 *
 * Why this exists
 * ---------------
 * Every Better Auth endpoint that reads or writes MongoDB (social sign-in,
 * email sign-in, sign-up, session lookup, ...) fails with an *empty-bodied*
 * HTTP 500 when MongoDB is unreachable. The browser therefore receives no
 * `message`, so the UI can only show a generic "something went wrong" — the
 * Google consent screen is never reached, which makes an infrastructure
 * problem look like a misconfigured OAuth client.
 *
 * This guard pings MongoDB first (cached, see lib/mongodb.ts) and answers with
 * a structured 503, so the failing step is unambiguous in the browser Network
 * tab, in the server logs and at `/api/health`.
 */

/** Better Auth routes that cannot work without the database. */
const DATABASE_BACKED_ROOTS = [
  "/sign-in",
  "/sign-up",
  "/sign-out",
  "/callback",
  "/get-session",
  "/update-user",
  "/change-email",
  "/change-password",
  "/delete-user",
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/link-social",
  "/unlink-account",
  "/list-accounts",
  "/account-info",
];

export const DATABASE_UNAVAILABLE_CODE = "DATABASE_UNAVAILABLE";

/** `/api/auth/sign-in/social` -> `/sign-in/social` */
function authPathOf(pathname: string): string {
  return pathname.startsWith("/api/auth") ? pathname.slice("/api/auth".length) : pathname;
}

/** True when the Better Auth endpoint behind `pathname` needs MongoDB. */
export function isDatabaseBackedAuthPath(pathname: string): boolean {
  const path = authPathOf(pathname);
  return DATABASE_BACKED_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * Returns a 503 response when the request needs MongoDB and MongoDB is not
 * reachable, or `null` when the request may be handed to Better Auth.
 */
export async function guardDatabaseBackedAuthRequest(
  request: Request,
): Promise<Response | null> {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }

  if (!isDatabaseBackedAuthPath(pathname)) return null;

  const status = await getDatabaseStatus();
  if (status.reachable) return null;

  // Server-side only: the credential-free reason goes to the deployment logs.
  console.error(
    `[QurbaniHat] Auth endpoint ${pathname} blocked: MongoDB is unavailable ` +
      `(kind=${status.kind}, configured=${status.configured}, ` +
      `target=${status.target}, database=${status.database}). ${status.detail}` +
      (status.raw ? ` Driver said: ${status.raw}` : ""),
  );

  return Response.json(
    {
      code: DATABASE_UNAVAILABLE_CODE,
      message: "The authentication service cannot reach its database right now.",
      detail: status.detail,
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
