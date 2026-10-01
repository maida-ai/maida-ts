import { describe, it, expect } from "vitest";
import { computeSignature, detectLoop, patternKey } from "../src/loopdetect.js";
import { redactAndTruncate } from "../src/redact.js";

function makeEvent(
  eventType: string,
  payload: Record<string, unknown> = {},
  eventId?: string,
): Record<string, unknown> {
  return { event_type: eventType, payload, event_id: eventId ?? `evt-${Math.random()}` };
}

describe("computeSignature", () => {
  it("rejects unnormalized arguments without printing them", () => {
    expect(() => computeSignature(makeEvent("TOOL_CALL", { tool_name: "inspect", args: Symbol("private") })))
      .toThrow("Loop arguments must be normalized JSON values");
  });
  it("LLM_CALL with model", () => {
    expect(computeSignature(makeEvent("LLM_CALL", { model: "gpt-4" }))).toBe(
      "LLM_CALL:gpt-4",
    );
  });

  it("LLM_CALL without model defaults to UNKNOWN", () => {
    expect(computeSignature(makeEvent("LLM_CALL", {}))).toBe("LLM_CALL:UNKNOWN");
  });

  it("TOOL_CALL with tool_name", () => {
    expect(computeSignature(makeEvent("TOOL_CALL", { tool_name: "search" }))).toBe(
      "TOOL_CALL:search",
    );
  });

  it("TOOL_CALL includes a bounded digest without scalar values", () => {
    expect(
      computeSignature(
        makeEvent("TOOL_CALL", {
          tool_name: "search",
          args: { query: "secret", filters: { limit: 10, archived: false } },
        }),
      ),
    ).toMatch(/^TOOL_CALL:search args:sha256:[a-f0-9]{64}$/);
  });

  it("TOOL_CALL without tool_name defaults to UNKNOWN", () => {
    expect(computeSignature(makeEvent("TOOL_CALL", {}))).toBe("TOOL_CALL:UNKNOWN");
  });

  it("other event types return the event_type string", () => {
    expect(computeSignature(makeEvent("RUN_START"))).toBe("RUN_START");
    expect(computeSignature(makeEvent("ERROR"))).toBe("ERROR");
  });

  it("missing event_type returns empty string", () => {
    expect(computeSignature({})).toBe("");
  });
});

describe("detectLoop", () => {
  it("uses caller redaction before equality and keeps warnings private", () => {
    const events = [0, 1, 2].map((i) => makeEvent("TOOL_CALL", {
      tool_name: "Bash",
      args: redactAndTruncate({ command: "private-command", private_value: `secret-${i}` },
        { redact: true, redact_keys: ["private_value"], max_field_bytes: 1000 }),
    }));
    const warning = detectLoop(events, 12, 3)!;
    expect(warning.pattern_length).toBe(1);
    expect(warning.pattern).toBe(computeSignature(events[0]));
    expect(JSON.stringify(warning)).not.toContain("private");
    expect(JSON.stringify(events)).not.toContain("secret-");
  });
  it("compares only arguments remaining after capture truncation", () => {
    const events = [0, 1, 2].map((i) => makeEvent("TOOL_CALL", {
      tool_name: "Bash",
      args: redactAndTruncate({ command: "private-prefix".repeat(100) + `suffix-${i}` },
        { redact: true, redact_keys: [], max_field_bytes: 100 }),
    }));
    const warning = detectLoop(events, 12, 3)!;
    expect(warning.pattern).toBe(computeSignature(events[0]));
    expect(JSON.stringify(warning)).not.toContain("private-prefix");
    expect(JSON.stringify(events)).not.toContain("suffix-");
  });
  it.each([
    ["Bash", "command", ["pytest", "git status", "cat pyproject.toml"]],
    ["Read", "file_path", ["a.py", "b.py", "c.py"]],
  ])("distinct %s calls do not warn", (tool, key, values) => {
    const events = (values as string[]).map((value) =>
      makeEvent("TOOL_CALL", { tool_name: tool, args: { [key as string]: value } }));
    expect(detectLoop(events, 12, 3)).toBeNull();
  });

  it.each([
    [["pytest", "pytest", "pytest"], 1],
    [["pytest", "git status", "pytest", "git status", "pytest", "git status"], 2],
  ])("same tool detects argument repetition and cycles", (commands, length) => {
    const events = (commands as string[]).map((command, i) =>
      makeEvent("TOOL_CALL", { tool_name: "Bash", args: { command } }, `e-${i}`));
    const warning = detectLoop(events, 12, 3)!;
    expect(warning.pattern_length).toBe(length);
    expect(warning.pattern_type).toBe(length === 2 ? "cycle" : "repeated_call");
    expect(warning.evidence_event_ids).toEqual(events.map((event) => event.event_id));
    for (const command of commands as string[]) expect(JSON.stringify(warning)).not.toContain(command);
    expect(new Set(warning.pattern.split(" -> ")).size).toBe(length);
  });

  it("canonicalizes object order while preserving array order, types and all items", () => {
    const signature = (args: unknown) => computeSignature(makeEvent("TOOL_CALL", { tool_name: "inspect", args }));
    expect(signature({ z: [true, null, 1, 1.5, "é😀"], a: { command: "private" } }))
      .toBe(signature({ a: { command: "private" }, z: [true, null, 1, 1.5, "é😀"] }));
    for (const [left, right] of [
      [[1, 2, 3, 4], [1, 2, 3, 5]], [[1, 2], [2, 1]], [true, 1], ["1", 1], [{}, []],
      [{ root: { branch: { leaf: { hidden: "a" } } } }, { root: { branch: { leaf: { hidden: "b" } } } }],
    ]) expect(signature(left)).not.toBe(signature(right));
  });

  it("returns null for empty events", () => {
    expect(detectLoop([], 12, 3)).toBeNull();
  });

  it("returns null for repetitions < 2", () => {
    const events = [makeEvent("LLM_CALL", { model: "gpt-4" })];
    expect(detectLoop(events, 12, 1)).toBeNull();
  });

  it("returns null for window < 2", () => {
    const events = [makeEvent("LLM_CALL", { model: "gpt-4" })];
    expect(detectLoop(events, 1, 3)).toBeNull();
  });

  it("detects simple repeated pattern", () => {
    const events = [
      makeEvent("TOOL_CALL", { tool_name: "search" }),
      makeEvent("TOOL_CALL", { tool_name: "search" }),
      makeEvent("TOOL_CALL", { tool_name: "search" }),
    ];
    const result = detectLoop(events, 12, 3);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("TOOL_CALL:search");
    expect(result!.pattern_type).toBe("repeated_call");
    expect(result!.pattern_length).toBe(1);
    expect(result!.repetitions).toBe(3);
  });

  it("detects multi-step repeated pattern", () => {
    const events = [
      makeEvent("LLM_CALL", { model: "gpt-4" }),
      makeEvent("TOOL_CALL", { tool_name: "search" }),
      makeEvent("LLM_CALL", { model: "gpt-4" }),
      makeEvent("TOOL_CALL", { tool_name: "search" }),
      makeEvent("LLM_CALL", { model: "gpt-4" }),
      makeEvent("TOOL_CALL", { tool_name: "search" }),
    ];
    const result = detectLoop(events, 12, 3);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("LLM_CALL:gpt-4 -> TOOL_CALL:search");
    expect(result!.pattern_type).toBe("cycle");
    expect(result!.pattern_length).toBe(2);
    expect(result!.repetitions).toBe(3);
  });

  it("selects smallest pattern length m", () => {
    // 6 repeated single-events could match m=1 rep=3 or m=2 rep=3
    const events = [
      makeEvent("LLM_CALL", { model: "gpt-4" }),
      makeEvent("LLM_CALL", { model: "gpt-4" }),
      makeEvent("LLM_CALL", { model: "gpt-4" }),
      makeEvent("LLM_CALL", { model: "gpt-4" }),
      makeEvent("LLM_CALL", { model: "gpt-4" }),
      makeEvent("LLM_CALL", { model: "gpt-4" }),
    ];
    const result = detectLoop(events, 12, 3);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("LLM_CALL:gpt-4");
  });

  it("returns null when no loop exists", () => {
    const events = [
      makeEvent("LLM_CALL", { model: "gpt-4" }),
      makeEvent("TOOL_CALL", { tool_name: "search" }),
      makeEvent("LLM_CALL", { model: "gpt-3.5" }),
      makeEvent("TOOL_CALL", { tool_name: "write" }),
    ];
    expect(detectLoop(events, 12, 3)).toBeNull();
  });

  it("respects window size", () => {
    const events = [
      makeEvent("TOOL_CALL", { tool_name: "other" }),
      makeEvent("TOOL_CALL", { tool_name: "search" }),
      makeEvent("TOOL_CALL", { tool_name: "search" }),
      makeEvent("TOOL_CALL", { tool_name: "search" }),
    ];
    // Window=3: only last 3 events considered, which are 3x search
    const result = detectLoop(events, 3, 3);
    expect(result).not.toBeNull();
    expect(result!.pattern).toBe("TOOL_CALL:search");
  });

  it("includes evidence_event_ids", () => {
    const events = [
      makeEvent("TOOL_CALL", { tool_name: "search" }, "e1"),
      makeEvent("TOOL_CALL", { tool_name: "search" }, "e2"),
      makeEvent("TOOL_CALL", { tool_name: "search" }, "e3"),
    ];
    const result = detectLoop(events, 12, 3);
    expect(result!.evidence_event_ids).toEqual(["e1", "e2", "e3"]);
  });

  it("uses __MISSING__ for events without event_id", () => {
    const events = [
      { event_type: "TOOL_CALL", payload: { tool_name: "s" } },
      { event_type: "TOOL_CALL", payload: { tool_name: "s" } },
      { event_type: "TOOL_CALL", payload: { tool_name: "s" } },
    ];
    const result = detectLoop(events, 12, 3);
    expect(result!.evidence_event_ids).toEqual([
      "__MISSING__",
      "__MISSING__",
      "__MISSING__",
    ]);
  });
});

describe("patternKey", () => {
  it("produces stable dedup key", () => {
    expect(
      patternKey({ pattern: "TOOL_CALL:search", repetitions: 3, window_size: 12, evidence_event_ids: [] }),
    ).toBe("TOOL_CALL:search|3");
  });

  it("handles missing fields", () => {
    expect(patternKey({} as Record<string, unknown>)).toBe("|0");
  });
});
