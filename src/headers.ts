import { Env } from "./env";

/**
 * `ALLOWED_ORIGINS` may be unset, `"*"`, a single origin, or a comma-separated
 * list of origins.
 *
 * - unset -> no header (CORS blocked)
 * - a single value (with or without commas absent) -> returned as-is, e.g. "*"
 * - a comma-separated list -> the request's `Origin` is echoed back only if
 *   it matches one of the list entries, and `vary: origin` is set so shared
 *   caches don't serve one origin's response to another.
 */
export function corsHeaders(
  request: Request,
  env: Env
): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS;
  if (!allowed) return {};

  if (!allowed.includes(",")) {
    return { "access-control-allow-origin": allowed };
  }

  const origins = allowed
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const requestOrigin = request.headers.get("origin");

  const headers: Record<string, string> = { vary: "origin" };
  if (requestOrigin && origins.includes(requestOrigin)) {
    headers["access-control-allow-origin"] = requestOrigin;
  }
  return headers;
}

export function optionsCorsHeaders(
  allowedMethods: string[]
): Record<string, string> {
  return {
    "access-control-allow-methods": allowedMethods.join(", "),
    "access-control-allow-headers":
      "range, if-match, if-none-match, if-modified-since, if-unmodified-since, if-range",
    "access-control-max-age": "86400",
  };
}

/** Builds a Headers object, omitting any entry whose value is empty/undefined. */
export function buildHeaders(
  entries: Record<string, string | undefined>
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(entries)) {
    if (value) headers.set(key, value);
  }
  return headers;
}

/** Cache/CORS validator headers shared by 200/206/304/412 responses for a given object. */
export function fileHeaders(
  file: R2Object,
  env: Env,
  request: Request,
  extra: Record<string, string | undefined> = {}
): Headers {
  return buildHeaders({
    etag: file.httpEtag,
    "cache-control": file.httpMetadata?.cacheControl ?? env.CACHE_CONTROL,
    expires: file.httpMetadata?.cacheExpiry?.toUTCString(),
    "last-modified": file.uploaded.toUTCString(),
    ...corsHeaders(request, env),
    ...extra,
  });
}
