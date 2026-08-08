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

      if (attempts <= maxAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempts - 1), 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}
