/**
 * Toasts globaux RTK Query : branché dans `baseQueryWithReauth`.
 *
 * - Succès : uniquement les **mutations** dont la réponse JSON contient `message` (string non vide).
 * - Erreur : **queries** et **mutations**, message depuis le body d’erreur Nest (`message`) ou message réseau.
 * - `401` : pas de toast (déconnexion gérée ailleurs).
 *
 * Par endpoint, sur l’objet retourné par `query()` :
 *   `skipToast`, `skipSuccessToast`, `skipErrorToast` (retirés avant le fetch).
 */
import type { BaseQueryApi } from "@reduxjs/toolkit/query";
import type { FetchBaseQueryError } from "@reduxjs/toolkit/query";
import type { FetchArgs } from "@reduxjs/toolkit/query";
import { emitApiToast } from "./apiToastBridge";
import type { ApiToastSeverity } from "./apiToastBridge";

/** Optional flags on the object returned from endpoint `query()` — stripped before `fetch`. */
export type ApiToastFlags = {
  /** No success toast for this request */
  skipSuccessToast?: boolean;
  /** No error toast for this request */
  skipErrorToast?: boolean;
  /** Shorthand: skip both */
  skipToast?: boolean;
};

export function peelToastFlags(arg: string | (FetchArgs & ApiToastFlags)): {
  arg: string | FetchArgs;
  flags: ApiToastFlags;
} {
  if (typeof arg === "string") {
    return { arg, flags: {} };
  }
  const { skipSuccessToast, skipErrorToast, skipToast, ...rest } =
    arg as FetchArgs & ApiToastFlags;
  return {
    arg: rest as FetchArgs,
    flags: {
      skipSuccessToast: skipSuccessToast === true,
      skipErrorToast: skipErrorToast === true,
      skipToast: skipToast === true,
    },
  };
}

function extractSuccessMessage(data: unknown): string | null {
  if (data instanceof Blob) return null;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const msg = d.message;
  if (typeof msg === "string" && msg.trim()) return msg.trim();
  return null;
}

/** True for RTK Query's own in-flight cancellations (stale room/query switch), not a real failure. */
function isAbortError(error: FetchBaseQueryError): boolean {
  return (
    error.status === "FETCH_ERROR" &&
    typeof error.error === "string" &&
    /abort/i.test(error.error)
  );
}

function extractErrorMessage(error: FetchBaseQueryError): string {
  const status = error.status;
  if (
    status === "FETCH_ERROR" ||
    status === "PARSING_ERROR" ||
    status === "TIMEOUT_ERROR"
  ) {
    if (typeof error.error === "string" && error.error.trim()) {
      return error.error;
    }
    return "Problème de connexion. Vérifiez votre réseau et réessayez.";
  }

  const data = error.data as unknown;
  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    const msg = o.message;
    if (Array.isArray(msg)) {
      const parts = msg.filter((m) => typeof m === "string") as string[];
      if (parts.length) return parts.join(", ");
    }
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  }
  if (typeof data === "string" && data.trim()) return data.trim();

  if (typeof status === "number") {
    return `Erreur ${status}`;
  }
  return "Une erreur est survenue.";
}

/**
 * Shows success/error toasts from API payloads. Call after `baseQuery` returns.
 * - Success: mutations only, if backend returns a non-empty `message` string.
 * - Error: queries and mutations, unless skipped or 401 (session handled elsewhere).
 */
export function applyApiResultToasts(
  result: { data?: unknown; error?: FetchBaseQueryError },
  api: Pick<BaseQueryApi, "type" | "endpoint">,
  flags: ApiToastFlags,
): void {
  const skipAll = flags.skipToast === true;
  const skipSuccess = skipAll || flags.skipSuccessToast === true;
  const skipError = skipAll || flags.skipErrorToast === true;

  if (result.error) {
    if (skipError) return;
    const status = result.error.status;
    if (status === 401) return;
    if (isAbortError(result.error)) return;
    const msg = extractErrorMessage(result.error);
    emitApiToast(msg, "error" as ApiToastSeverity);
    return;
  }

  if (skipSuccess) return;
  if (api.type !== "mutation") return;

  const msg = extractSuccessMessage(result.data);
  if (msg) {
    emitApiToast(msg, "success" as ApiToastSeverity);
  }
}
