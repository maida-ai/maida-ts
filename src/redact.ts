/**
 * Pure redaction and truncation utilities.
 * Mirrors maida/maida/_tracing/_redact.py — Python is the source of truth.
 */

import type { MaidaConfig } from "./types.js";
import { DEPTH_LIMIT, REDACTED_MARKER, TRUNCATED_MARKER } from "./constants.js";

const RECURSION_LIMIT = DEPTH_LIMIT;

export function keyMatchesRedact(key: string, redactKeys: string[]): boolean {
  const k = key.toLowerCase();
  return redactKeys.some((rk) => k.includes(rk.toLowerCase()));
}

export function truncateString(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return s;
  const buf = Buffer.from(s, "utf-8");
  if (buf.length <= maxBytes) return s;
  const markerBytes = Buffer.byteLength(TRUNCATED_MARKER, "utf-8");
  const limit = Math.max(0, maxBytes - markerBytes);
  const truncated = buf.subarray(0, limit).toString("utf-8");
  return truncated + TRUNCATED_MARKER;
}

export function redactAndTruncate(
  obj: unknown,
  config: Pick<MaidaConfig, "redact" | "redact_keys" | "max_field_bytes">,
  depth: number = 0,
): unknown {
  if (depth > RECURSION_LIMIT) return TRUNCATED_MARKER;
  if (obj === null || obj === undefined) return obj ?? null;
  if (typeof obj === "boolean" || typeof obj === "number") return obj;
  if (typeof obj === "string") return truncateString(obj, config.max_field_bytes);
  if (Array.isArray(obj)) {
    return obj.map((item) => redactAndTruncate(item, config, depth + 1));
  }
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const keyStr = String(k);
      if (config.redact && keyMatchesRedact(keyStr, config.redact_keys)) {
        out[keyStr] = REDACTED_MARKER;
      } else {
        out[keyStr] = redactAndTruncate(v, config, depth + 1);
      }
    }
    return out;
  }
  const s = String(obj);
  if (Buffer.byteLength(s, "utf-8") > config.max_field_bytes) {
    return truncateString(s, config.max_field_bytes);
  }
  return s;
}

export function normalizeUsage(
  usage: unknown,
): { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null } | null {
  if (usage == null) return null;
  if (typeof usage !== "object" || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;

  function tokenVal(key: string): number | null {
    const v = u[key];
    if (v == null) return null;
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    return null;
  }

  return {
    prompt_tokens: tokenVal("prompt_tokens"),
    completion_tokens: tokenVal("completion_tokens"),
    total_tokens: tokenVal("total_tokens"),
  };
}

export function buildErrorPayload(
  err: Error | string | Record<string, unknown> | null | undefined,
  config: Pick<MaidaConfig, "redact" | "redact_keys" | "max_field_bytes">,
  includeStack: boolean = true,
): Record<string, unknown> | null {
  if (err == null) return null;

  let errObj: Record<string, unknown>;

  if (err instanceof Error) {
    errObj = {
      error_type: err.constructor.name,
      message: err.message,
      details: null,
      stack: includeStack ? err.stack ?? null : null,
    };
  } else if (typeof err === "string") {
    errObj = {
      error_type: "Error",
      message: err,
      details: null,
      stack: null,
    };
  } else if (typeof err === "object" && !Array.isArray(err)) {
    errObj = {
      error_type: (err.error_type as string) ?? (err.type as string) ?? "Error",
      message: (err.message as string) ?? "",
      details: err.details ?? null,
      stack: includeStack ? (err.stack ?? null) : null,
    };
  } else {
    errObj = {
      error_type: "Error",
      message: String(err),
      details: null,
      stack: null,
    };
  }

  return redactAndTruncate(errObj, config) as Record<string, unknown>;
}
