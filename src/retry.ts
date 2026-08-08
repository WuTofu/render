import { Env } from "./env";

export async function retryAsync<T>(env: Env, fn: () => Promise<T>): Promise<T> {
  const maxAttempts = env.R2_RETRIES || 0;
  let attempts = 0;

  while (maxAttempts == -1 || attempts <= maxAttempts) {
    try {
      return await fn();
    } catch (err) {
      attempts++;
      if (env.LOGGING) console.error(`Attempt ${attempts} failed:`, err);

      if (maxAttempts == -1 || attempts <= maxAttempts) {
        // Capped lower than before (was 30s) since this sleep happens inside
        // a live request; with R2_RETRIES = -1 (unlimited, see wrangler.toml)
        // a request that never succeeds would otherwise spend most of its
        // time asleep rather than retrying.
        const delay = Math.min(1000 * Math.pow(2, attempts - 1), 5000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}
