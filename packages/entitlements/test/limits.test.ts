// Pure limit math. Ported from the ShaSha app's quota tests, generalized.

import { describe, expect, test } from "bun:test";
import { canAdd, periodExpired, remaining } from "../src/limits";

describe("limit math", () => {
  test("canAdd bounds use", () => {
    expect(canAdd(0, 1, 3)).toBe(true);
    expect(canAdd(2, 1, 3)).toBe(true);
    expect(canAdd(3, 1, 3)).toBe(false);
    expect(canAdd(3, 0, 3)).toBe(true);
    expect(canAdd(0, 1, 0)).toBe(false);
    expect(canAdd(1, -1, 3)).toBe(false);
  });

  test("remaining never goes below zero", () => {
    expect(remaining(0, 5)).toBe(5);
    expect(remaining(5, 5)).toBe(0);
    expect(remaining(7, 5)).toBe(0);
    expect(remaining(2, 0)).toBe(0);
  });

  test("period rollover", () => {
    const start = Date.UTC(2026, 0, 1);
    expect(periodExpired(start, start + 29 * 86_400_000, 30)).toBe(false);
    expect(periodExpired(start, start + 30 * 86_400_000, 30)).toBe(true);
    expect(periodExpired(start, start + 400 * 86_400_000)).toBe(false);
  });
});
