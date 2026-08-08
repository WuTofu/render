import { Env } from "./env";
import {
  ParsedRange,
  rangeHasLength,
  getRangeHeader,
  parseRangeHeader,
} from "./range";
import { hasBody, parsePreconditions } from "./conditional";
import { corsOriginHeader } from "./headers";
import { makeListingResponse } from "./listing";
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
        headers: { allow: allowedMethods.join(", ") },
      });
    }

    let triedIndex = false;

    let response: Response | undefined;

    const isCachingEnabled = env.CACHE_CONTROL !== "no-store";
    const cache = caches.default;
    if (isCachingEnabled) {
      response = await cache.match(request);
    }

    // Since we produce this result from the request, we don't need to strictly use an R2Range
    let range: ParsedRange | undefined;

    if (!response || !(response.ok || response.status == 304)) {
      if (env.LOGGING) {
        console.warn("Cache MISS for", request.url);
      }
      const url = new URL(request.url);
      let path = (env.PATH_PREFIX || "") + decodeURIComponent(url.pathname);

      // directory logic
      if (path.endsWith("/")) {
        // if theres an index file, try that. 404 logic down below has dir fallback.
        if (env.INDEX_FILE && env.INDEX_FILE !== "") {
          path += env.INDEX_FILE;
          triedIndex = true;
        } else if (env.DIRECTORY_LISTING) {
          // return the dir listing
          let listResponse = await makeListingResponse(path, env, request);

          if (listResponse !== null) {
            if (listResponse.headers.get("cache-control") !== "no-store") {
              ctx.waitUntil(cache.put(request, listResponse.clone()));
            }
            return listResponse;
          }
        }
      }

      if (path !== "/" && path.startsWith("/")) {
        path = path.substring(1);
      }

      let file: R2Object | R2ObjectBody | null | undefined;

      // Range handling
      if (request.method === "GET") {
        const rangeHeader = request.headers.get("range");
        if (rangeHeader) {
          file = await retryAsync(env, () => env.R2_BUCKET.head(path));
          if (file === null)
            return new Response("File Not Found", { status: 404 });
          const parsed = parseRangeHeader(file.size, rangeHeader);
          if (parsed === "unsatisfiable") {
            return new Response("Range Not Satisfiable", { status: 416 });
          }
          range = parsed;
        }
      }

      // Etag/If-(Not)-Match handling
      const { ifMatch, ifNoneMatch, ifModifiedSince, ifUnmodifiedSince, ifRange } =
        parsePreconditions(request);

      if (range && ifRange && file) {
        const maybeDate = Date.parse(ifRange);

        if (isNaN(maybeDate) || new Date(maybeDate) > file.uploaded) {
          // httpEtag already has quotes, no need to use getHeaderEtag
          if (ifRange.startsWith("W/") || ifRange !== file.httpEtag)
            range = undefined;
        }
      }

      if (ifMatch || ifUnmodifiedSince) {
        file = await retryAsync(env, () =>
          env.R2_BUCKET.get(path, {
            onlyIf: {
              etagMatches: ifMatch,
              uploadedBefore: ifUnmodifiedSince
                ? new Date(ifUnmodifiedSince)
                : undefined,
            },
            range,
          })
        );

        if (file && !hasBody(file)) {
          return new Response("Precondition Failed", { status: 412 });
        }
      }

      if (ifNoneMatch || ifModifiedSince) {
        // if-none-match overrides if-modified-since completely
        if (ifNoneMatch) {
          file = await retryAsync(env, () =>
            env.R2_BUCKET.get(path, {
              onlyIf: { etagDoesNotMatch: ifNoneMatch },
              range,
            })
          );
        } else if (ifModifiedSince) {
          file = await retryAsync(env, () =>
            env.R2_BUCKET.get(path, {
              onlyIf: { uploadedAfter: new Date(ifModifiedSince) },
              range,
            })
          );
        }
        if (file && !hasBody(file)) {
          return new Response(null, { status: 304 });
        }
      }

      file =
        request.method === "HEAD"
          ? await retryAsync(env, () => env.R2_BUCKET.head(path))
          : file && hasBody(file)
          ? file
          : await retryAsync(env, () => env.R2_BUCKET.get(path, { range }));

      let notFound: boolean = false;

      if (file === null) {
        if (env.INDEX_FILE && triedIndex) {
          // remove the index file since it doesn't exist
          path = path.substring(0, path.length - env.INDEX_FILE.length);
        }

        if (env.DIRECTORY_LISTING && (path.endsWith("/") || path === "")) {
          // return the dir listing
          let listResponse = await makeListingResponse(path, env, request);

          if (listResponse !== null) {
            if (listResponse.headers.get("cache-control") !== "no-store") {
              ctx.waitUntil(cache.put(request, listResponse.clone()));
            }
            return listResponse;
          }
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

      // Content-Length handling
      let body;
      let contentLength = file.size;
      if (hasBody(file) && file.size !== 0) {
        if (range && !notFound) {
          contentLength = rangeHasLength(range) ? range.length : range.suffix;
        }
        let { readable, writable } = new FixedLengthStream(contentLength);
        file.body.pipeTo(writable);
        body = readable;
      }
      response = new Response(body, {
        status: notFound ? 404 : range ? 206 : 200,
        headers: {
          "accept-ranges": "bytes",
          "access-control-allow-origin": corsOriginHeader(env),

          etag: notFound ? "" : file.httpEtag,
          // if the 404 file has a custom cache control, we respect it
          "cache-control":
            file.httpMetadata?.cacheControl ??
            (notFound ? "" : env.CACHE_CONTROL || ""),
          expires: file.httpMetadata?.cacheExpiry?.toUTCString() ?? "",
          "last-modified": notFound ? "" : file.uploaded.toUTCString(),

          "content-encoding": file.httpMetadata?.contentEncoding ?? "",
          "content-type":
            file.httpMetadata?.contentType ?? "application/octet-stream",
          "content-language": file.httpMetadata?.contentLanguage ?? "",
          "content-disposition": file.httpMetadata?.contentDisposition ?? "",
          "content-range":
            range && !notFound ? getRangeHeader(range, file.size) : "",
          "content-length": contentLength.toString(),
        },
      });

      if (request.method === "GET" && !range && isCachingEnabled && !notFound)
        ctx.waitUntil(cache.put(request, response.clone()));
    } else {
      if (env.LOGGING) {
        console.warn("Cache HIT for", request.url);
      }
    }

    return response;
  },
};
