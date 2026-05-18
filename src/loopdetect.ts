/**
 * Loop detection for agent runs: signature computation and repeated-pattern detection.
 * Mirrors maida/maida/loopdetect.py — Python is the source of truth.
 *
 * Pure functions, no I/O.
 */

const MISSING_EVENT_ID = "__MISSING__";

export interface LoopWarningPayload {
  pattern: string;
  repetitions: number;
  window_size: number;
  evidence_event_ids: string[];
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
    return "TOOL_CALL:" + String(toolName);
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
