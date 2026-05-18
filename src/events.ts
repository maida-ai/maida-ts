/**
 * Event factory and pure helpers for Maida trace events.
 * Mirrors maida/maida/events.py — Python is the source of truth.
 *
 * Pure functions, no I/O, unit-testable.
 */

import { randomUUID } from "node:crypto";

import type { MaidaEvent, EventType } from "./types.js";
import { DEPTH_LIMIT, SPEC_VERSION, TRUNCATED_MARKER } from "./constants.js";

const MAX_JSON_DEPTH = DEPTH_LIMIT;

export function utcNowIsoMsZ(): string {
  return new Date().toISOString();
}

function jsonSafeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_JSON_DEPTH) return TRUNCATED_MARKER;
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === "boolean" || t === "number" || t === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => jsonSafeValue(item, depth + 1));
  }
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[String(k)] = jsonSafeValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function ensureJsonSafe(obj: unknown): unknown {
  return jsonSafeValue(obj, 0);
}

export interface NewEventOpts {
  parentId?: string | null;
  durationMs?: number | null;
  meta?: Record<string, unknown> | null;
}

export function newEvent(
  eventType: EventType | string,
  runId: string,
  name: string,
  payload: unknown,
  opts?: NewEventOpts,
): MaidaEvent {
  const eventId = randomUUID();
  const ts = utcNowIsoMsZ();

  let safePayload = payload != null ? ensureJsonSafe(payload) : {};
  if (typeof safePayload !== "object" || safePayload === null || Array.isArray(safePayload)) {
    safePayload = { value: safePayload };
  }

  let safeMeta = opts?.meta != null ? ensureJsonSafe(opts.meta) : {};
  if (typeof safeMeta !== "object" || safeMeta === null || Array.isArray(safeMeta)) {
    safeMeta = { value: safeMeta };
  }

  return {
    spec_version: SPEC_VERSION,
    event_id: eventId,
    run_id: runId,
    parent_id: opts?.parentId ?? null,
    event_type: typeof eventType === "string" ? eventType : String(eventType),
    ts,
    duration_ms: opts?.durationMs ?? null,
    name: String(name),
    payload: safePayload as Record<string, unknown>,
    meta: safeMeta as Record<string, unknown>,
  };
}
