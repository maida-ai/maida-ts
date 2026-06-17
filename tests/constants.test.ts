import { describe, it, expect } from "vitest";
import {
  REDACTED_MARKER,
  TRUNCATED_MARKER,
  SPEC_VERSION,
  DEPTH_LIMIT,
  defaultCounts,
} from "../src/constants.js";

describe("constants", () => {
  it("REDACTED_MARKER matches Python", () => {
    expect(REDACTED_MARKER).toBe("__REDACTED__");
  });

  it("TRUNCATED_MARKER matches Python", () => {
    expect(TRUNCATED_MARKER).toBe("__TRUNCATED__");
  });

  it("SPEC_VERSION matches Python", () => {
    expect(SPEC_VERSION).toBe("0.2");
  });

  it("DEPTH_LIMIT matches Python", () => {
    expect(DEPTH_LIMIT).toBe(10);
  });

  it("defaultCounts returns correct shape with all zeros", () => {
    const counts = defaultCounts();
    expect(counts).toEqual({
      llm_calls: 0,
      tool_calls: 0,
      errors: 0,
      loop_warnings: 0,
    });
  });

  it("defaultCounts returns a new object each call", () => {
    const a = defaultCounts();
    const b = defaultCounts();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
