import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  validateRunId,
  validateTraceId,
  createRun,
  appendEvent,
  appendSpan,
  finalizeRun,
  loadValidatedRun,
} from "../src/storage.js";
import { newEvent } from "../src/events.js";
import { EventType } from "../src/types.js";
import { REDACTED_MARKER, SPEC_VERSION } from "../src/constants.js";

function makeTmpDataDir(): string {
  const dir = join(tmpdir(), `maida-storage-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const d of cleanupDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  cleanupDirs.length = 0;
});

describe("validateRunId", () => {
  it("accepts a valid UUID v4", () => {
    const id = randomUUID();
    expect(validateRunId(id)).toBe(id);
  });

  it("rejects empty string", () => {
    expect(() => validateRunId("")).toThrow("invalid run_id");
  });

  it("rejects path traversal with ../", () => {
    expect(() => validateRunId("../etc/passwd")).toThrow("invalid run_id");
  });

  it("rejects path with /", () => {
    expect(() => validateRunId("abc/def")).toThrow("invalid run_id");
  });

  it("rejects path with backslash", () => {
    expect(() => validateRunId("abc\\def")).toThrow("invalid run_id");
  });

  it("rejects non-UUID strings", () => {
    expect(() => validateRunId("not-a-uuid")).toThrow("invalid run_id");
  });

  it("rejects UUID v1 format", () => {
    // UUID v1 has version nibble '1' in the 3rd group
    expect(() => validateRunId("550e8400-e29b-11d4-a716-446655440000")).toThrow(
      "invalid run_id",
    );
  });

  it("rejects uppercase UUID", () => {
    const id = randomUUID().toUpperCase();
    expect(() => validateRunId(id)).toThrow("invalid run_id");
  });
});

describe("validateTraceId", () => {
  it("accepts a 32-character lowercase hex trace id", () => {
    const traceId = "0123456789abcdef0123456789abcdef";
    expect(validateTraceId(traceId)).toBe(traceId);
  });

  it("normalizes uppercase trace ids", () => {
    expect(validateTraceId("ABCDEF0123456789ABCDEF0123456789")).toBe(
      "abcdef0123456789abcdef0123456789",
    );
  });

  it("rejects path traversal", () => {
    expect(() => validateTraceId("../0123456789abcdef01234567")).toThrow(
      "invalid trace_id",
    );
  });
});

describe("createRun", () => {
  it("creates a current OTel trace directory with meta.json", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const result = createRun("test-run", { data_dir: dataDir });

    expect(result.spec_version).toBe(SPEC_VERSION);
    expect(result.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(result.run_id).toBe(result.trace_id);
    expect(result.run_name).toBe("test-run");
    expect(result.status).toBe("running");
    expect(result.ended_at).toBeNull();
    expect(result.duration_ms).toBeNull();
    expect(result.counts).toEqual({
      llm_calls: 0,
      tool_calls: 0,
      errors: 0,
      loop_warnings: 0,
    });

    const metaJson = JSON.parse(readFileSync(result.paths.meta_json, "utf-8"));
    expect(metaJson.spec_version).toBe(SPEC_VERSION);
    expect(metaJson.trace_id).toBe(result.trace_id);
    expect(metaJson.run_name).toBe("test-run");
    expect(metaJson.status).toBe("running");
    expect(metaJson).not.toHaveProperty("run_id");
  });

  it("creates run with null name", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const result = createRun(null, { data_dir: dataDir });
    expect(result.run_name).toBeNull();
  });
});

describe("appendEvent", () => {
  it("appends event-shaped input as current span JSONL lines", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const run = createRun("test", { data_dir: dataDir });

    const evt1 = newEvent(EventType.RUN_START, run.run_id, "test", {});
    const evt2 = newEvent(EventType.LLM_CALL, run.run_id, "gpt-4", {
      model: "gpt-4",
      prompt: "hello",
    });
    appendEvent(run.run_id, evt1, { data_dir: dataDir });
    appendEvent(run.run_id, evt2, { data_dir: dataDir });

    const content = readFileSync(run.paths.spans_jsonl, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const parsed1 = JSON.parse(lines[0]);
    const parsed2 = JSON.parse(lines[1]);
    expect(parsed1.trace_id).toBe(run.trace_id);
    // Unparented events nest under the deterministic run root span id.
    expect(parsed1.parent_span_id).toBe(run.trace_id.slice(0, 16));
    expect(parsed1.attributes["maida.event_type"]).toBe("RUN_START");
    expect(parsed2.attributes["gen_ai.request.model"]).toBe("gpt-4");
    expect(parsed2.events[0].name).toBe("gen_ai.user.message");
  });

  it("each line is valid JSON", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const run = createRun("test", { data_dir: dataDir });

    for (let i = 0; i < 5; i++) {
      appendEvent(
        run.run_id,
        newEvent(EventType.TOOL_CALL, run.run_id, `tool-${i}`, { tool_name: `t${i}` }),
        { data_dir: dataDir },
      );
    }

    const lines = readFileSync(run.paths.spans_jsonl, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it("links a child span to its parent event via parent_id", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const run = createRun("linked", { data_dir: dataDir });

    const startEvt = newEvent(EventType.RUN_START, run.trace_id, "linked", {});
    appendEvent(run.trace_id, startEvt, { data_dir: dataDir });
    const childEvt = newEvent(
      EventType.LLM_CALL,
      run.trace_id,
      "gpt-4",
      { model: "gpt-4" },
      { parentId: startEvt.event_id },
    );
    appendEvent(run.trace_id, childEvt, { data_dir: dataDir });

    const [startSpan, childSpan] = readFileSync(run.paths.spans_jsonl, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    // The UUID parent_id resolves to the same span id the parent event produced.
    expect(childSpan.parent_span_id).not.toBeNull();
    expect(childSpan.parent_span_id).toBe(startSpan.span_id);
  });
});

describe("appendSpan", () => {
  it("redacts arbitrary span attributes and event attributes before storage", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const run = createRun("privacy", { data_dir: dataDir });

    appendSpan(
      run.trace_id,
      {
        trace_id: run.trace_id,
        span_id: "0123456789abcdef",
        parent_span_id: null,
        name: "raw-span",
        kind: "INTERNAL",
        start_time: new Date().toISOString(),
        end_time: new Date().toISOString(),
        duration_ms: 0,
        attributes: {
          api_key: "sk-secret",
          "gen_ai.usage.total_tokens": 10,
        },
        events: [
          {
            name: "raw-event",
            timestamp: new Date().toISOString(),
            attributes: { authorization: "Bearer secret" },
          },
        ],
        status_code: "OK",
        status_description: "ok",
      },
      { data_dir: dataDir },
    );

    const [stored] = readFileSync(run.paths.spans_jsonl, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(stored.attributes.api_key).toBe(REDACTED_MARKER);
    expect(stored.attributes["gen_ai.usage.total_tokens"]).toBe(10);
    expect(stored.events[0].attributes.authorization).toBe(REDACTED_MARKER);
  });
});

describe("finalizeRun", () => {
  it("updates meta.json with ended_at, duration_ms, status, counts and a root span", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const run = createRun("test", { data_dir: dataDir });

    const counts = { llm_calls: 3, tool_calls: 5, errors: 0, loop_warnings: 1 };
    finalizeRun(run.run_id, "ok", counts, { data_dir: dataDir });

    const meta = JSON.parse(readFileSync(run.paths.meta_json, "utf-8"));
    expect(meta.status).toBe("ok");
    expect(meta.ended_at).toMatch(/Z$/);
    expect(typeof meta.duration_ms).toBe("number");
    expect(meta.duration_ms).toBeGreaterThanOrEqual(0);
    expect(meta.counts).toEqual(counts);

    const spans = readFileSync(run.paths.spans_jsonl, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(spans.some((span) => span.parent_span_id === null)).toBe(true);
  });

  it("finalizes with error status", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const run = createRun("test", { data_dir: dataDir });

    finalizeRun(
      run.run_id,
      "error",
      { llm_calls: 1, tool_calls: 0, errors: 1, loop_warnings: 0 },
      { data_dir: dataDir },
    );

    const meta = JSON.parse(readFileSync(run.paths.meta_json, "utf-8"));
    expect(meta.status).toBe("error");
    expect(meta.counts.errors).toBe(1);
  });

  it("throws for non-existent run", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const fakeId = "0123456789abcdef0123456789abcdef";
    // Create the runs dir so the trace id is valid but meta.json doesn't exist
    mkdirSync(join(dataDir, "runs", fakeId), { recursive: true });
    expect(() =>
      finalizeRun(
        fakeId,
        "ok",
        { llm_calls: 0, tool_calls: 0, errors: 0, loop_warnings: 0 },
        { data_dir: dataDir },
      ),
    ).toThrow(/meta\.json not found/);
  });
});

describe("loadValidatedRun", () => {
  it("loads a finalized current-format run", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const run = createRun("validated", { data_dir: dataDir });

    appendEvent(
      run.trace_id,
      newEvent(EventType.TOOL_CALL, run.trace_id, "search", {
        tool_name: "search",
        args: { query: "test" },
        result: "ok",
      }),
      { data_dir: dataDir },
    );
    finalizeRun(
      run.trace_id,
      "ok",
      { llm_calls: 0, tool_calls: 1, errors: 0, loop_warnings: 0 },
      { data_dir: dataDir },
    );

    const loaded = loadValidatedRun(run.trace_id, { data_dir: dataDir });
    expect(loaded.meta.trace_id).toBe(run.trace_id);
    expect(loaded.spans.length).toBeGreaterThanOrEqual(2);
  });

  it("throws a clear validation error for malformed current-format runs", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const run = createRun("broken", { data_dir: dataDir });

    expect(() => loadValidatedRun(run.trace_id, { data_dir: dataDir })).toThrow(
      /spans\.jsonl contains no spans/,
    );
  });
});

describe("end-to-end: create, append, finalize", () => {
  it("produces valid run readable by Python format expectations", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);

    const run = createRun("e2e-test", { data_dir: dataDir });
    const startEvt = newEvent(EventType.RUN_START, run.run_id, "e2e-test", {});
    appendEvent(run.run_id, startEvt, { data_dir: dataDir });

    const llmEvt = newEvent(EventType.LLM_CALL, run.run_id, "gpt-4", {
      model: "gpt-4",
      prompt: "hello",
      response: "world",
    }, { durationMs: 150 });
    appendEvent(run.run_id, llmEvt, { data_dir: dataDir });

    const toolEvt = newEvent(EventType.TOOL_CALL, run.run_id, "search", {
      tool_name: "search",
      args: { query: "test" },
      result: "found it",
      status: "ok",
    }, { durationMs: 50 });
    appendEvent(run.run_id, toolEvt, { data_dir: dataDir });

    const endEvt = newEvent(EventType.RUN_END, run.run_id, "e2e-test", { status: "ok" });
    appendEvent(run.run_id, endEvt, { data_dir: dataDir });

    finalizeRun(
      run.run_id,
      "ok",
      { llm_calls: 1, tool_calls: 1, errors: 0, loop_warnings: 0 },
      { data_dir: dataDir },
    );

    // Verify meta.json
    const meta = JSON.parse(readFileSync(run.paths.meta_json, "utf-8"));
    expect(meta.spec_version).toBe(SPEC_VERSION);
    expect(meta.trace_id).toBe(run.trace_id);
    expect(meta.status).toBe("ok");
    expect(meta.counts.llm_calls).toBe(1);
    expect(meta.counts.tool_calls).toBe(1);

    // Verify spans.jsonl
    const spans = readFileSync(run.paths.spans_jsonl, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(spans).toHaveLength(5);
    expect(spans[0].attributes["maida.event_type"]).toBe("RUN_START");
    expect(spans[1].attributes["gen_ai.request.model"]).toBe("gpt-4");
    expect(spans[2].attributes["maida.tool_name"]).toBe("search");
    expect(spans[3].attributes["maida.event_type"]).toBe("RUN_END");

    // Exactly one root (the synthetic run root from finalizeRun), and every
    // event-derived span nests under it.
    const roots = spans.filter((s) => s.parent_span_id === null);
    expect(roots).toHaveLength(1);
    const rootSpan = roots[0];
    expect(rootSpan.span_id).toBe(run.trace_id.slice(0, 16));
    for (const span of spans.slice(0, 4)) {
      expect(span.parent_span_id).toBe(rootSpan.span_id);
    }

    // Every span has all required current-format fields
    for (const span of spans) {
      expect(span).toHaveProperty("trace_id", run.trace_id);
      expect(span).toHaveProperty("span_id");
      expect(span).toHaveProperty("parent_span_id");
      expect(span).toHaveProperty("name");
      expect(span).toHaveProperty("kind");
      expect(span).toHaveProperty("start_time");
      expect(span).toHaveProperty("end_time");
      expect(span).toHaveProperty("duration_ms");
      expect(span).toHaveProperty("attributes");
      expect(span).toHaveProperty("events");
      expect(span).toHaveProperty("status_code");
      expect(span).toHaveProperty("status_description");
    }
  });
});
