import { describe, expect, it, vi } from "vitest";
import { retryAsync } from "../src/retry";
import type { Env } from "../src/env";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { R2_BUCKET: {} as R2Bucket, LOGGING: false, ...overrides };
}

describe("retryAsync", () => {
  it("returns the result on success with no retries needed", async () => {
    const result = await retryAsync(makeEnv(), async () => "ok");
    expect(result).toBe("ok");
  });

  it("R2_RETRIES = 0 throws on the first failure without retrying", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(retryAsync(makeEnv({ R2_RETRIES: 0 }), fn)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("R2_RETRIES = 2 retries up to the configured count then throws", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    vi.useFakeTimers();
    const promise = retryAsync(makeEnv({ R2_RETRIES: 2 }), fn);
    const assertion = expect(promise).rejects.toThrow("boom");
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
    expect(fn).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it("R2_RETRIES = -1 retries indefinitely until success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    vi.useFakeTimers();
    const promise = retryAsync(makeEnv({ R2_RETRIES: -1 }), fn);
    await vi.runAllTimersAsync();
    const result = await promise;
    vi.useRealTimers();
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
