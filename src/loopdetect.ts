/**
 * Loop detection for agent runs: signature computation and repeated-pattern detection.
 * Mirrors maida/maida/loopdetect.py — Python is the source of truth.
 *
 * Pure functions, no I/O.
 */

const MISSING_EVENT_ID = "__MISSING__";
const MAX_SIGNATURE_DEPTH = 4;
const MAX_SEQUENCE_ITEMS = 3;

export interface LoopWarningPayload {
  pattern: string;
  pattern_type: "repeated_call" | "cycle";
  pattern_length: number;
  repetitions: number;
  window_size: number;
  evidence_event_ids: string[];
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  if (typeof value === "string") return "str";
  if (typeof value === "boolean") return "bool";
  return typeof value;
}

function structuralSignature(value: unknown, depth = 0): string {
  if (depth >= MAX_SIGNATURE_DEPTH) return "...";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const itemShapes: string[] = [];
    for (const item of value.slice(0, MAX_SEQUENCE_ITEMS)) {
      const shape = structuralSignature(item, depth + 1);
      if (!itemShapes.includes(shape)) itemShapes.push(shape);
    }
    const suffix = value.length > MAX_SEQUENCE_ITEMS ? ",..." : "";
    return `[${itemShapes.join("|")}${suffix}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length === 0) return "{}";
    return `{${keys
      .map((key) => `${key}:${structuralSignature(record[key], depth + 1)}`)
      .join(",")}}`;
  }
  return typeName(value);
}

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
      signature += " args:" + structuralSignature(payload.args);
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
