import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/wrangler.test.toml" },
    }),
  ],
  test: {
    pool: "@cloudflare/vitest-pool-workers",
  },
});
