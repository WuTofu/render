export function hasBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
  return (<R2ObjectBody>object).body !== undefined;
}

// R2 requires that etag checks must not contain quotes, and the S3 spec only allows one etag.
// This silently ignores invalid or weak (W/) headers.
export function getHeaderEtag(header: string | null): string | undefined {
  return header?.trim().replace(/^['"]|['"]$/g, "");
}

export interface ParsedPreconditions {
  ifMatch: string | undefined;
  ifNoneMatch: string | undefined;
  ifModifiedSince: number;
  ifUnmodifiedSince: number;
  ifRange: string | null;
}

export function parsePreconditions(request: Request): ParsedPreconditions {
  return {
    ifMatch: getHeaderEtag(request.headers.get("if-match")),
    ifNoneMatch: getHeaderEtag(request.headers.get("if-none-match")),
    ifModifiedSince: Date.parse(request.headers.get("if-modified-since") || ""),
    ifUnmodifiedSince: Date.parse(request.headers.get("if-unmodified-since") || ""),
    ifRange: request.headers.get("if-range"),
  };
}
