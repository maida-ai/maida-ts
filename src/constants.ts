/**
 * Shared constants: spec version, count schema, and redaction/truncation markers.
 * Mirrors maida/maida/constants.py — Python is the source of truth.
 */

import type { RunCounts } from "./types.js";

export const REDACTED_MARKER = "__REDACTED__";
export const TRUNCATED_MARKER = "__TRUNCATED__";
export const SPEC_VERSION = "0.2";
export const DEPTH_LIMIT = 10;

export function defaultCounts(): RunCounts {
  return {
    llm_calls: 0,
    tool_calls: 0,
    errors: 0,
    loop_warnings: 0,
  };
}
