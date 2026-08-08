import { Env } from "./env";
import { corsOriginHeader } from "./headers";

const units = ["B", "KB", "MB", "GB", "TB"];

export function niceBytes(x: number) {
  let l = 0,
    n = parseInt(x.toString(), 10) || 0;

  while (n >= 1000 && ++l) {
    n = n / 1000;
  }

  return n.toFixed(n < 10 && l > 0 ? 1 : 0) + " " + units[l];
}

// some ideas for this were taken from / inspired by
// https://github.com/cloudflare/workerd/blob/main/samples/static-files-from-disk/static.js
export async function makeListingResponse(
  path: string,
  env: Env,
  request: Request
): Promise<Response | null> {
  if (path === "/") path = "";
  else if (path !== "" && !path.endsWith("/")) {
    path += "/";
  }
  let cursor = new URL(request.url).searchParams.get("cursor") || undefined;
  let listing = await env.R2_BUCKET.list({
    prefix: path,
    delimiter: "/",
    cursor,
    limit: env.ITEMS_PER_PAGE || 1000,
  });

  if (listing.delimitedPrefixes.length === 0 && listing.objects.length === 0) {
    return null;
  }

  let html: string = "";
  let lastModified: Date | null = null;

  if (request.method === "GET") {
    let htmlList = [];

    if (path !== "") {
      htmlList.push(
        `      <tr>` +
          `<td><a href="../">../</a></td>` +
          `<td>-</td><td>-</td></tr>`
      );
    }

    for (let dir of listing.delimitedPrefixes) {
      if (dir.endsWith("/")) dir = dir.substring(0, dir.length - 1);
      let name = dir.substring(path.length, dir.length);
      if (name.startsWith(".") && env.HIDE_HIDDEN_FILES) continue;
      htmlList.push(
        `      <tr>` +
          `<td><a href="${encodeURIComponent(name)}/">${name}/</a></td>` +
          `<td>-</td><td>-</td></tr>`
      );
    }
    for (let file of listing.objects) {
      let name = file.key.substring(path.length, file.key.length);
      if (name.startsWith(".") && env.HIDE_HIDDEN_FILES) continue;

      let dateStr = file.uploaded.toISOString();
      dateStr = dateStr.split(".")[0].replace("T", " ");
      dateStr = dateStr.slice(0, dateStr.lastIndexOf(":")) + "Z";

      htmlList.push(
        `      <tr>` +
          `<td><a href="${encodeURIComponent(name)}">${name}</a></td>` +
          `<td>${dateStr}</td><td>${niceBytes(file.size)}</td></tr>`
      );

      if (lastModified == null || file.uploaded > lastModified) {
        lastModified = file.uploaded;
      }
    }

    if (listing.truncated) {
      htmlList.push(
        `      <tr>` +
          `<td><a href="?cursor=${listing.cursor}">...see more.../</a></td>` +
          `<td>-</td><td>-</td></tr>`
      );
    }

    if (path === "") path = "/";

    html = `<!DOCTYPE html>
<html>
  <head>
    <title>Index of ${path}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta charset="utf-8">
    <style>
      td { padding-right: 16px; text-align: right; font-family: monospace }
      td:nth-of-type(1) { text-align: left; overflow-wrap: anywhere }
      td:nth-of-type(3) { white-space: nowrap }
      th { text-align: left; }
      @media (prefers-color-scheme: dark) {
        body {
          color: white;
          background-color: #1c1b22;
        }
        a {
          color: #3391ff;
        }
        a:visited {
          color: #C63B65;
        }
      }
    </style>
  </head>
  <body>
    <h1>Index of ${path}</h1>
    <table>
      <tr><th>Filename</th><th>Modified</th><th>Size</th></tr>
${htmlList.join("\n")}
    </table>
  </body>
</html>
  `;
  }

  return new Response(html === "" ? null : html, {
    status: 200,
    headers: {
      "access-control-allow-origin": corsOriginHeader(env),
      "last-modified": lastModified === null ? "" : lastModified.toUTCString(),
      "content-type": "text/html",
      "cache-control": env.DIRECTORY_CACHE_CONTROL || "no-store",
    },
  });
}
