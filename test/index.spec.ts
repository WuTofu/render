import { env as rawEnv, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

// `wrangler types` isn't run as part of this project's build, so the ambient
// `Cloudflare.Env` from `cloudflare:test` doesn't know about our bindings/vars.
// Cast once here against our own `Env` type instead.
const env = rawEnv as unknown as Env;

async function fetch(path: string, init?: RequestInit): Promise<Response> {
  const request = new Request(`http://example.com${path}`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

const FILE_BODY = "0123456789";

beforeAll(async () => {
  await env.R2_BUCKET.put("file.txt", FILE_BODY, {
    httpMetadata: { contentType: "text/plain" },
  });
  await env.R2_BUCKET.put("dir/a.txt", "a");
  await env.R2_BUCKET.put("dir/b.txt", "b");
});

describe("methods", () => {
  it("rejects unsupported methods with 405 + allow header", async () => {
    const res = await fetch("/file.txt", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("responds to OPTIONS with an allow header", async () => {
    const res = await fetch("/file.txt", { method: "OPTIONS" });
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
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
  it("if-none-match hits with a matching etag -> 304", async () => {
    const first = await fetch("/file.txt");
    const etag = first.headers.get("etag")!;
    const res = await fetch("/file.txt", {
      headers: { "if-none-match": etag },
    });
    expect(res.status).toBe(304);
  });

  it("if-none-match misses with a non-matching etag -> 200", async () => {
    const res = await fetch("/file.txt", {
      headers: { "if-none-match": '"not-the-real-etag"' },
    });
    expect(res.status).toBe(200);
  });

  it("if-match misses with a non-matching etag -> 412", async () => {
    const res = await fetch("/file.txt", {
      headers: { "if-match": '"not-the-real-etag"' },
    });
    expect(res.status).toBe(412);
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
});

describe("directory listing", () => {
  it("lists objects under a prefix", async () => {
    const res = await fetch("/dir/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("a.txt");
    expect(html).toContain("b.txt");
  });
});
