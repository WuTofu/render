import { env as rawEnv, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

// `wrangler types` isn't run as part of this project's build, so the ambient
// `Cloudflare.Env` from `cloudflare:test` doesn't know about our bindings/vars.
// Cast once here against our own `Env` type instead.
const env = rawEnv as unknown as Env;

async function fetch(path: string, init?: RequestInit): Promise<Response> {
  return fetchWithEnv(path, {}, init);
}

async function fetchWithEnv(
  path: string,
  envOverrides: Partial<Env>,
  init?: RequestInit
): Promise<Response> {
  const request = new Request(`http://example.com${path}`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, { ...env, ...envOverrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const FILE_BODY = "0123456789";

const XSS_NAME = '<img src=x onerror="alert(1)">.txt';

beforeAll(async () => {
  await env.R2_BUCKET.put("file.txt", FILE_BODY, {
    httpMetadata: { contentType: "text/plain" },
  });
  await env.R2_BUCKET.put("dir/a.txt", "a");
  await env.R2_BUCKET.put("dir/b.txt", "b");
  await env.R2_BUCKET.put(`xss/${XSS_NAME}`, "x");
  await env.R2_BUCKET.put("xss/<b>/inner.txt", "x");
});

describe("methods", () => {
  it("rejects unsupported methods with 405 + allow header", async () => {
    const res = await fetch("/file.txt", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("responds to OPTIONS with an allow header and CORS preflight headers", async () => {
    const res = await fetch("/file.txt", { method: "OPTIONS" });
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe(
      "GET, HEAD, OPTIONS"
    );
    expect(res.headers.get("access-control-allow-headers")).toContain("range");
  });

  it("serves HEAD with no body", async () => {
    const res = await fetch("/file.txt", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("basic GET", () => {
  it("serves a file with etag and content-type", async () => {
    const res = await fetch("/file.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FILE_BODY);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("etag")).toBeTruthy();
  });

  it("404s on a missing file", async () => {
    const res = await fetch("/nope.txt");
    expect(res.status).toBe(404);
  });

  it("400s on a malformed percent-encoded path instead of crashing", async () => {
    const res = await fetch("/%");
    expect(res.status).toBe(400);
  });

  it("passes through a pre-compressed object's content-encoding and body untouched", async () => {
    // Guards against workerd's `brotli_content_encoding` compat flag (2024-04-29)
    // treating a stored `br`/`gzip` content-encoding as something to negotiate
    // or transcode rather than an opaque passthrough header.
    const compressed = "not actually compressed, just bytes";
    await env.R2_BUCKET.put("compressed.br", compressed, {
      httpMetadata: { contentType: "text/plain", contentEncoding: "br" },
    });
    const res = await fetch("/compressed.br");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("content-length")).toBe(String(compressed.length));
    expect(await res.text()).toBe(compressed);
  });

  it("resolves a dot-segment path the same way the runtime's URL parser normalizes it", async () => {
    // Guards against `specCompliantUrl` (2022-10-31) changing how `.`/`..`
    // segments in the pathname are collapsed before we look up the R2 key.
    const res = await fetch("/dir/../file.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(FILE_BODY);
  });
});

describe("range requests", () => {
  it("serves a byte range with 206 + content-range", async () => {
    const res = await fetch("/file.txt", { headers: { range: "bytes=0-3" } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("0123");
    expect(res.headers.get("content-range")).toBe(`bytes 0-3/${FILE_BODY.length}`);
  });

  it("serves an open-ended range", async () => {
    const res = await fetch("/file.txt", { headers: { range: "bytes=5-" } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("56789");
  });

  it("serves a suffix range", async () => {
    const res = await fetch("/file.txt", { headers: { range: "bytes=-3" } });
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("789");
  });

  it("rejects a multi-range request with 416", async () => {
    const res = await fetch("/file.txt", {
      headers: { range: "bytes=0-1,3-4" },
    });
    expect(res.status).toBe(416);
  });

  it("rejects an out-of-bounds range with 416", async () => {
    const res = await fetch("/file.txt", {
      headers: { range: "bytes=1000-2000" },
    });
    expect(res.status).toBe(416);
  });
});

describe("preconditions", () => {
  it("if-none-match hits with a matching etag -> 304 with cache validators", async () => {
    const first = await fetch("/file.txt");
    const etag = first.headers.get("etag")!;
    const res = await fetch("/file.txt", {
      headers: { "if-none-match": etag },
    });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("last-modified")).toBeTruthy();
  });

  it("if-none-match misses with a non-matching etag -> 200", async () => {
    const res = await fetch("/file.txt", {
      headers: { "if-none-match": '"not-the-real-etag"' },
    });
    expect(res.status).toBe(200);
  });

  it("if-match misses with a non-matching etag -> 412 with cache validators", async () => {
    const first = await fetch("/file.txt");
    const realEtag = first.headers.get("etag")!;
    const res = await fetch("/file.txt", {
      headers: { "if-match": '"not-the-real-etag"' },
    });
    expect(res.status).toBe(412);
    expect(res.headers.get("etag")).toBe(realEtag);
  });

  it("if-match hits with a matching etag -> 200", async () => {
    const first = await fetch("/file.txt");
    const etag = first.headers.get("etag")!;
    const res = await fetch("/file.txt", { headers: { "if-match": etag } });
    expect(res.status).toBe(200);
  });

  it("if-modified-since in the future -> 304", async () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const res = await fetch("/file.txt", {
      headers: { "if-modified-since": future },
    });
    expect(res.status).toBe(304);
  });

  it("if-match takes precedence over if-unmodified-since (RFC 9110 §13.2.2)", async () => {
    const first = await fetch("/file.txt");
    const etag = first.headers.get("etag")!;
    // if-match passes, if-unmodified-since (satisfied by any past date) is
    // irrelevant to the outcome, but must not be evaluated on its own.
    const res = await fetch("/file.txt", {
      headers: {
        "if-match": etag,
        "if-unmodified-since": new Date(0).toUTCString(),
      },
    });
    expect(res.status).toBe(200);
  });

  it("if-none-match takes precedence over if-modified-since (RFC 9110 §13.2.2)", async () => {
    const first = await fetch("/file.txt");
    const etag = first.headers.get("etag")!;
    // if-none-match fails to preclude (etag doesn't match) -> 200, even
    // though if-modified-since alone (a future date) would say 304.
    const future = new Date(Date.now() + 60_000).toUTCString();
    const res = await fetch("/file.txt", {
      headers: {
        "if-none-match": '"not-the-real-etag"',
        "if-modified-since": future,
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(etag);
  });

  it("does not serve a stale 304 from the edge cache", async () => {
    // Simulate an edge cache entry from before the object was re-uploaded:
    // the Cache API would evaluate if-modified-since itself and return a
    // stale 304 for it. Conditional requests must skip that lookup and
    // validate against R2 instead.
    const matchSpy = vi.spyOn(caches.default, "match").mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: { "last-modified": new Date(0).toUTCString() },
      })
    );
    const headSpy = vi.spyOn(env.R2_BUCKET, "head");
    try {
      const res = await fetchWithEnv(
        "/file.txt",
        { CACHE_CONTROL: "public, max-age=86400" },
        { headers: { "if-modified-since": new Date(0).toUTCString() } }
      );
      expect(res.status).toBe(200);
      expect(matchSpy).not.toHaveBeenCalled();
      expect(headSpy).toHaveBeenCalledTimes(1);
    } finally {
      matchSpy.mockRestore();
      headSpy.mockRestore();
    }
  });

  it("serves a cache hit only after revalidating the etag", async () => {
    const first = await fetch("/file.txt");
    const etag = first.headers.get("etag")!;
    const cached = new Response(FILE_BODY, { status: 200, headers: { etag } });
    const matchSpy = vi.spyOn(caches.default, "match").mockResolvedValue(cached);
    const getSpy = vi.spyOn(env.R2_BUCKET, "get");
    const headSpy = vi.spyOn(env.R2_BUCKET, "head");
    try {
      const res = await fetchWithEnv("/file.txt", {
        CACHE_CONTROL: "public, max-age=86400",
      });
      expect(res).toBe(cached);
      expect(headSpy).toHaveBeenCalledTimes(1);
      expect(getSpy).not.toHaveBeenCalled();
    } finally {
      matchSpy.mockRestore();
      getSpy.mockRestore();
      headSpy.mockRestore();
    }
  });

  it("re-fetches when the cached copy's etag is stale", async () => {
    // A re-upload changed the object's etag since this entry was cached;
    // the stale body must not be served.
    const cached = new Response("stale body", {
      status: 200,
      headers: { etag: '"stale"' },
    });
    const matchSpy = vi.spyOn(caches.default, "match").mockResolvedValue(cached);
    const getSpy = vi.spyOn(env.R2_BUCKET, "get");
    try {
      const res = await fetchWithEnv("/file.txt", {
        CACHE_CONTROL: "public, max-age=86400",
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(FILE_BODY);
      expect(getSpy).toHaveBeenCalledTimes(1);
    } finally {
      matchSpy.mockRestore();
      getSpy.mockRestore();
    }
  });
});

describe("R2 operation count", () => {
  it("costs one R2 call for a plain GET", async () => {
    const spy = vi.spyOn(env.R2_BUCKET, "get");
    const headSpy = vi.spyOn(env.R2_BUCKET, "head");
    try {
      await fetch("/file.txt");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(headSpy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      headSpy.mockRestore();
    }
  });

  it("costs one R2 call (head only) for a 304", async () => {
    const first = await fetch("/file.txt");
    const etag = first.headers.get("etag")!;

    const getSpy = vi.spyOn(env.R2_BUCKET, "get");
    const headSpy = vi.spyOn(env.R2_BUCKET, "head");
    try {
      const res = await fetch("/file.txt", {
        headers: { "if-none-match": etag },
      });
      expect(res.status).toBe(304);
      expect(headSpy).toHaveBeenCalledTimes(1);
      expect(getSpy).not.toHaveBeenCalled();
    } finally {
      getSpy.mockRestore();
      headSpy.mockRestore();
    }
  });
});

describe("directory listing", () => {
  it("lists objects under a prefix", async () => {
    const res = await fetch("/dir/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("a.txt");
    expect(html).toContain("b.txt");
  });

  it("HTML-escapes object names instead of injecting them raw", async () => {
    const res = await fetch("/xss/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;.txt");
  });

  it("HTML-escapes the request path in the title/heading", async () => {
    const res = await fetch("/xss/%3Cb%3E/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;");
  });
});

describe("CORS with a comma-separated ALLOWED_ORIGINS list", () => {
  const overrides = { ALLOWED_ORIGINS: "https://a.example, https://b.example" };

  it("echoes back a matching origin and sets vary: origin", async () => {
    const res = await fetchWithEnv("/file.txt", overrides, {
      headers: { origin: "https://a.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://a.example"
    );
    expect(res.headers.get("vary")).toBe("origin");
  });

  it("omits access-control-allow-origin for a non-matching origin", async () => {
    const res = await fetchWithEnv("/file.txt", overrides, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("vary")).toBe("origin");
  });
});

describe("empty headers are omitted, not sent blank", () => {
  it("omits content-range and etag from a 404 response", async () => {
    const res = await fetch("/does-not-exist.txt");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-range")).toBeNull();
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("last-modified")).toBeNull();
  });

  it("omits content-range on a non-ranged 200 response", async () => {
    const res = await fetch("/file.txt");
    expect(res.headers.get("content-range")).toBeNull();
  });
});
