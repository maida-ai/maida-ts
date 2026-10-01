/**
 * Loop detection for agent runs: signature computation and repeated-pattern detection.
 * Mirrors maida/maida/loopdetect.py — Python is the source of truth.
 *
 * Pure functions, no I/O.
 */

import { createHash } from "node:crypto";

const MISSING_EVENT_ID = "__MISSING__";

export interface LoopWarningPayload {
  pattern: string;
  pattern_type: "repeated_call" | "cycle";
  pattern_length: number;
  repetitions: number;
  window_size: number;
  evidence_event_ids: string[];
}

// Tagged containers prevent collisions with scalar encodings. IEEE-754 bytes
// give Python/JS numbers the same identity without JSON formatting differences.
function canonicalArgs(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value === 0 ? 0 : value);
    return ["number", bytes.toString("hex")];
  }
  if (Array.isArray(value)) return ["array", value.map(canonicalArgs)];
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return ["object", Object.keys(record).sort().map((key) => [key, canonicalArgs(record[key])])];
  }
  throw new TypeError("Loop arguments must be normalized JSON values");
}

function argumentFingerprint(args: unknown): string {
  // Match Python ensure_ascii=True, including UTF-16 surrogate pairs.
  const canonical = JSON.stringify(canonicalArgs(args)).replace(/[\u007f-\uffff]/g,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
  return createHash("sha256").update(canonical, "ascii").digest("hex");
}

/** Callers must apply configured redaction/truncation before supplying args. */
export function computeSignature(event: Record<string, unknown>): string {
  const t = event.event_type;
  if (t === "LLM_CALL") {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const model = (payload.model as string) || "UNKNOWN";
    return "LLM_CALL:" + String(model);
  }
  if (t === "TOOL_CALL") {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const toolName = (payload.tool_name as string) || "UNKNOWN";
    let signature = "TOOL_CALL:" + String(toolName);
    if (payload.args !== null && payload.args !== undefined) {
      signature += " args:sha256:" + argumentFingerprint(payload.args);
    }
    return signature;
  }
  return String(t ?? "");
}

export function detectLoop(
  events: Record<string, unknown>[],
  window: number,
  repetitions: number,
): LoopWarningPayload | null {
  if (!events.length || repetitions < 2 || window < 2) return null;

  const eventsWindow = events.length >= window ? events.slice(-window) : events;
  const n = eventsWindow.length;
  const sigs = eventsWindow.map(computeSignature);

  const maxM = Math.floor(n / repetitions);
  if (maxM < 1) return null;

  for (let m = 1; m <= maxM; m++) {
    const L = m * repetitions;
    if (L > n) continue;
    const tail = sigs.slice(-L);
    const block = tail.slice(0, m);

    let match = true;
    for (let i = 0; i < repetitions; i++) {
      const chunk = tail.slice(i * m, (i + 1) * m);
      if (chunk.length !== block.length || !chunk.every((v, j) => v === block[j])) {
        match = false;
        break;
      }
    }

    if (match) {
      const evidenceEvents = eventsWindow.slice(-L);
      const evidenceEventIds = evidenceEvents.map(
        (e) => (e.event_id as string) || MISSING_EVENT_ID,
      );
      const pattern = block.join(" -> ");
      return {
        pattern,
        pattern_type: m === 1 ? "repeated_call" : "cycle",
        pattern_length: m,
        repetitions,
        window_size: eventsWindow.length,
        evidence_event_ids: evidenceEventIds,
      };
    }
  }
  return null;
}

export function patternKey(payload: LoopWarningPayload | Record<string, unknown>): string {
  const pattern = (payload.pattern as string) ?? "";
  const reps = (payload.repetitions as number) ?? 0;
  return `${pattern}|${reps}`;
}
