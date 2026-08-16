import { Env } from "./env";
import {
  ParsedRange,
  rangeHasLength,
  getRangeHeader,
  parseRangeHeader,
} from "./range";
import { evaluatePreconditions, hasBody, parsePreconditions } from "./conditional";
import {
  buildHeaders,
  corsHeaders,
  fileHeaders,
  hasNoStoreDirective,
  optionsCorsHeaders,
} from "./headers";
import { respondWithListing } from "./listing";
import { retryAsync } from "./retry";

export type { Env } from "./env";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const allowedMethods = ["GET", "HEAD", "OPTIONS"];
    if (allowedMethods.indexOf(request.method) === -1) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: allowedMethods.join(", ") },
      });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: buildHeaders({
          allow: allowedMethods.join(", "),
          ...optionsCorsHeaders(allowedMethods),
          ...corsHeaders(request, env),
        }),
      });
    }

    let triedIndex = false;

    const { ifMatch, ifNoneMatch, ifModifiedSince, ifUnmodifiedSince, ifRange } =
      parsePreconditions(request);
    const hasPreconditions =
      ifMatch !== undefined ||
      ifNoneMatch !== undefined ||
      ifModifiedSince !== undefined ||
      ifUnmodifiedSince !== undefined;

    const isCachingEnabled = !hasNoStoreDirective(env.CACHE_CONTROL);
    const cache = caches.default;

    const url = new URL(request.url);
    let decodedPathname: string;
    try {
      decodedPathname = decodeURIComponent(url.pathname);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }
    let path = (env.PATH_PREFIX || "") + decodedPathname;

    // directory logic
    if (path.endsWith("/")) {
      // if theres an index file, try that. 404 logic down below has dir fallback.
      if (env.INDEX_FILE && env.INDEX_FILE !== "") {
        path += env.INDEX_FILE;
        triedIndex = true;
      } else if (env.DIRECTORY_LISTING) {
        const listResponse = await respondWithListing(
          path,
          env,
          request,
          ctx,
          cache,
          isCachingEnabled,
          hasPreconditions
        );
        if (listResponse !== null) return listResponse;
      }
    }

    if (path !== "/" && path.startsWith("/")) {
      path = path.substring(1);
    }

    let file: R2Object | R2ObjectBody | null | undefined;

    const rangeHeader =
      request.method === "GET" ? request.headers.get("range") : null;

    // Since we produce this result from the request, we don't need to strictly use an R2Range
    let range: ParsedRange | undefined;

    // A cached copy is never trusted on its own: the edge cache doesn't know
    // when the underlying object changes, so a hit is only served once its
    // etag is confirmed against R2's live metadata below. That means a cache
    // hit costs one head() call (same as any HEAD/range/conditional request)
    // and a miss costs head() + get().
    const cached =
      isCachingEnabled &&
      !hasPreconditions &&
      request.method === "GET" &&
      rangeHeader === null
        ? await cache.match(request)
        : undefined;

    // A HEAD request, a range request, any precondition, or a candidate
    // cache hit needs the object's metadata (etag/uploaded/size) before we
    // know how - or whether - to serve a body. Resolving that with one
    // head() call lets us evaluate everything locally instead of
    // round-tripping to R2 once per condition via `onlyIf`.
    if (
      request.method === "HEAD" ||
      rangeHeader !== null ||
      hasPreconditions ||
      cached?.ok
    ) {
      file = await retryAsync(env, () => env.R2_BUCKET.head(path));

      if (file !== null) {
        if (rangeHeader !== null) {
          const parsed = parseRangeHeader(file.size, rangeHeader);
          if (parsed === "unsatisfiable") {
            return new Response("Range Not Satisfiable", { status: 416 });
          }
          range = parsed;
        }

        if (range && ifRange) {
          const maybeDate = Date.parse(ifRange);

          if (isNaN(maybeDate) || new Date(maybeDate) > file.uploaded) {
            // httpEtag already has quotes, no need to use getHeaderEtag
            if (ifRange.startsWith("W/") || ifRange !== file.httpEtag)
              range = undefined;
          }
        }

        const verdict = evaluatePreconditions(file, {
          ifMatch,
          ifNoneMatch,
          ifModifiedSince,
          ifUnmodifiedSince,
          ifRange,
        });
        if (verdict === 412) {
          return new Response("Precondition Failed", {
            status: 412,
            headers: fileHeaders(file, env, request),
          });
        }
        if (verdict === 304) {
          return new Response(null, {
            status: 304,
            headers: fileHeaders(file, env, request, { "accept-ranges": "bytes" }),
          });
        }

        if (cached?.ok && cached.headers.get("etag") === file.httpEtag) {
          if (env.LOGGING) console.warn("Cache HIT for", request.url);
          return cached;
        }
      }
    }

    if (request.method === "GET" && file !== null) {
      file = await retryAsync(env, () => env.R2_BUCKET.get(path, { range }));
    }
    // Every code path above sets `file` for both GET and HEAD (the only
    // methods reachable here); this just lets TypeScript see that too.
    file = file ?? null;

    let notFound: boolean = false;

    if (file === null) {
      if (env.INDEX_FILE && triedIndex) {
        // remove the index file since it doesn't exist
        path = path.substring(0, path.length - env.INDEX_FILE.length);
      }

      if (env.DIRECTORY_LISTING && (path.endsWith("/") || path === "")) {
        const listResponse = await respondWithListing(
          path,
          env,
          request,
          ctx,
          cache,
          isCachingEnabled,
          hasPreconditions
        );
        if (listResponse !== null) return listResponse;
      }

      if (env.NOTFOUND_FILE && env.NOTFOUND_FILE != "") {
        notFound = true;
        path = env.NOTFOUND_FILE;
        file =
          request.method === "HEAD"
            ? await retryAsync(env, () => env.R2_BUCKET.head(path))
            : await retryAsync(env, () => env.R2_BUCKET.get(path));
      }

      // if it's still null, either 404 is disabled or that file wasn't found either
      // this isn't an else because then there would have to be two of them
      if (file == null) {
        return new Response("File Not Found", { status: 404 });
      }
    }

    if (env.LOGGING) console.warn("Cache MISS for", request.url);

    // Content-Length handling
    let body;
    let contentLength = file.size;
    if (hasBody(file) && file.size !== 0) {
      if (range && !notFound) {
        contentLength = rangeHasLength(range) ? range.length : range.suffix;
      }
      let { readable, writable } = new FixedLengthStream(contentLength);
      // pipeTo's promise rejects if the R2 read fails mid-stream (e.g. the
      // object changed underneath us). The failure still propagates to the
      // client via the aborted `readable` side; this catch only prevents an
      // unhandled rejection from the pipe itself. Deliberately not wrapped
      // in ctx.waitUntil: the pipe only drains once something reads
      // `readable` (i.e. the response body is consumed), so waiting on it
      // here would block returning the response.
      file.body.pipeTo(writable).catch((err) => {
        if (env.LOGGING) console.error("Error piping R2 object body:", err);
      });
      body = readable;
    }
    const response = new Response(body, {
      status: notFound ? 404 : range ? 206 : 200,
      headers: buildHeaders({
        "accept-ranges": "bytes",
        ...corsHeaders(request, env),

        etag: notFound ? undefined : file.httpEtag,
        // if the 404 file has a custom cache control, we respect it
        "cache-control":
          file.httpMetadata?.cacheControl ??
          (notFound ? undefined : env.CACHE_CONTROL),
        expires: file.httpMetadata?.cacheExpiry?.toUTCString(),
        "last-modified": notFound ? undefined : file.uploaded.toUTCString(),

        "content-encoding": file.httpMetadata?.contentEncoding,
        "content-type":
          file.httpMetadata?.contentType ?? "application/octet-stream",
        "content-language": file.httpMetadata?.contentLanguage,
        "content-disposition": file.httpMetadata?.contentDisposition,
        "content-range":
          range && !notFound ? getRangeHeader(range, file.size) : undefined,
        "content-length": contentLength.toString(),
      }),
    });

    if (request.method === "GET" && !range && isCachingEnabled && !notFound)
      ctx.waitUntil(cache.put(request, response.clone()));

    return response;
  },
};
