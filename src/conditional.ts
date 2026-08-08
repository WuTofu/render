export function hasBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
  return (<R2ObjectBody>object).body !== undefined;
}

// R2 requires that etag checks must not contain quotes, and the S3 spec only allows one etag.
// This silently ignores invalid or weak (W/) headers.
export function getHeaderEtag(header: string | null): string | undefined {
  return header?.trim().replace(/^['"]|['"]$/g, "");
}

function etagsEqual(a: string, b: string): boolean {
  return getHeaderEtag(a) === getHeaderEtag(b);
}

export interface ParsedPreconditions {
  ifMatch: string | undefined;
  ifNoneMatch: string | undefined;
  ifModifiedSince: number | undefined;
  ifUnmodifiedSince: number | undefined;
  ifRange: string | null;
}

export function parsePreconditions(request: Request): ParsedPreconditions {
  const ifModifiedSince = Date.parse(request.headers.get("if-modified-since") || "");
  const ifUnmodifiedSince = Date.parse(
    request.headers.get("if-unmodified-since") || ""
  );

  return {
    ifMatch: getHeaderEtag(request.headers.get("if-match")),
    ifNoneMatch: getHeaderEtag(request.headers.get("if-none-match")),
    ifModifiedSince: isNaN(ifModifiedSince) ? undefined : ifModifiedSince,
    ifUnmodifiedSince: isNaN(ifUnmodifiedSince) ? undefined : ifUnmodifiedSince,
    ifRange: request.headers.get("if-range"),
  };
}

/**
 * Evaluates preconditions against a known object in RFC 9110 §13.2.2 order:
 * if-match takes precedence over if-unmodified-since (the latter is only
 * considered when if-match is absent), and if-none-match takes precedence
 * over if-modified-since the same way.
 */
export function evaluatePreconditions(
  file: Pick<R2Object, "httpEtag" | "uploaded">,
  preconditions: ParsedPreconditions
): "ok" | 304 | 412 {
  const { ifMatch, ifNoneMatch, ifModifiedSince, ifUnmodifiedSince } = preconditions;

  if (ifMatch !== undefined) {
    if (!etagsEqual(ifMatch, file.httpEtag)) return 412;
  } else if (ifUnmodifiedSince !== undefined) {
    if (file.uploaded.getTime() > ifUnmodifiedSince) return 412;
  }

  if (ifNoneMatch !== undefined) {
    if (etagsEqual(ifNoneMatch, file.httpEtag)) return 304;
  } else if (ifModifiedSince !== undefined) {
    if (file.uploaded.getTime() <= ifModifiedSince) return 304;
  }

  return "ok";
}
