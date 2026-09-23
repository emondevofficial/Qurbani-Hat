"use client";

import { createAuthClient } from "better-auth/react";

import { resolveBrowserBaseUrl } from "@/lib/app-url";

/**
 * Browser side Better Auth client.
 *
 * The base URL is normalised through lib/app-url.ts, so a mistyped
 * `NEXT_PUBLIC_BETTER_AUTH_URL=http://0.0.0.0:3000` can never be sent to the
 * browser as a navigation target. When the variable is absent the client falls
 * back to `window.location.origin`, which is always correct for the current
 * deployment.
 *
 * All secrets stay on the server — the client never receives MONGODB_URI,
 * BETTER_AUTH_SECRET or GOOGLE_CLIENT_SECRET.
 */
export const authClient = createAuthClient({
  baseURL: resolveBrowserBaseUrl(),
});

export const { useSession } = authClient;