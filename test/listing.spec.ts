import { describe, expect, it } from "vitest";
import { niceBytes } from "../src/listing";
import { hasNoStoreDirective } from "../src/headers";

describe("niceBytes", () => {
  it("formats sizes across units", () => {
    expect(niceBytes(0)).toBe("0 B");
    expect(niceBytes(999)).toBe("999 B");
    expect(niceBytes(1000)).toBe("1.0 KB");
    expect(niceBytes(1_500_000)).toBe("1.5 MB");
    expect(niceBytes(1_000_000_000)).toBe("1.0 GB");
  });

  it("does not run off the end of the units table past 1 PB", () => {
    // 1000 TB is off the end of ["B","KB","MB","GB","TB"]; must clamp at TB,
    // not index past the array and print "undefined".
    expect(niceBytes(1_000_000_000_000_000)).toBe("1000 TB");
  });
});

describe("hasNoStoreDirective", () => {
  it("matches an exact no-store value", () => {
    expect(hasNoStoreDirective("no-store")).toBe(true);
  });

  it("matches no-store combined with other directives", () => {
    expect(hasNoStoreDirective("no-store, max-age=0")).toBe(true);
    expect(hasNoStoreDirective("max-age=0, no-store")).toBe(true);
  });

  it("does not match when no-store is absent", () => {
    expect(hasNoStoreDirective("public, max-age=86400")).toBe(false);
    expect(hasNoStoreDirective(undefined)).toBe(false);
    expect(hasNoStoreDirective(null)).toBe(false);
    expect(hasNoStoreDirective("")).toBe(false);
  });
});
