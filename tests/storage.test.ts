import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { validateRunId, createRun, appendEvent, finalizeRun } from "../src/storage.js";
import { newEvent } from "../src/events.js";
import { EventType } from "../src/types.js";
import { SPEC_VERSION } from "../src/constants.js";

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

describe("createRun", () => {
  it("creates run directory with run.json", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const result = createRun("test-run", { data_dir: dataDir });

    expect(result.spec_version).toBe(SPEC_VERSION);
    expect(result.run_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
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

    // Verify file on disk
    const runJson = JSON.parse(readFileSync(result.paths.run_json, "utf-8"));
    expect(runJson.run_id).toBe(result.run_id);
    expect(runJson.status).toBe("running");
  });

  it("creates run with null name", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const result = createRun(null, { data_dir: dataDir });
    expect(result.run_name).toBeNull();
  });
});

describe("appendEvent", () => {
  it("appends events as JSONL lines", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const run = createRun("test", { data_dir: dataDir });

    const evt1 = newEvent(EventType.RUN_START, run.run_id, "test", {});
    const evt2 = newEvent(EventType.LLM_CALL, run.run_id, "gpt-4", { model: "gpt-4" });
    appendEvent(run.run_id, evt1, { data_dir: dataDir });
    appendEvent(run.run_id, evt2, { data_dir: dataDir });

    const content = readFileSync(run.paths.events_jsonl, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);

    const parsed1 = JSON.parse(lines[0]);
    const parsed2 = JSON.parse(lines[1]);
    expect(parsed1.event_type).toBe("RUN_START");
    expect(parsed2.event_type).toBe("LLM_CALL");
    expect(parsed2.payload.model).toBe("gpt-4");
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

    const lines = readFileSync(run.paths.events_jsonl, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("finalizeRun", () => {
  it("updates run.json with ended_at, duration_ms, status, counts", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const run = createRun("test", { data_dir: dataDir });

    const counts = { llm_calls: 3, tool_calls: 5, errors: 0, loop_warnings: 1 };
    finalizeRun(run.run_id, "ok", counts, { data_dir: dataDir });

    const meta = JSON.parse(readFileSync(run.paths.run_json, "utf-8"));
    expect(meta.status).toBe("ok");
    expect(meta.ended_at).toMatch(/Z$/);
    expect(typeof meta.duration_ms).toBe("number");
    expect(meta.duration_ms).toBeGreaterThanOrEqual(0);
    expect(meta.counts).toEqual(counts);
    expect(meta.last_event_ts).toBe(meta.ended_at);
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

    const meta = JSON.parse(readFileSync(run.paths.run_json, "utf-8"));
    expect(meta.status).toBe("error");
    expect(meta.counts.errors).toBe(1);
  });

  it("throws for non-existent run", () => {
    const dataDir = makeTmpDataDir();
    cleanupDirs.push(dataDir);
    const fakeId = randomUUID();
    // Create the runs dir so the path is valid but run.json doesn't exist
    mkdirSync(join(dataDir, "runs", fakeId), { recursive: true });
    expect(() =>
      finalizeRun(
        fakeId,
        "ok",
        { llm_calls: 0, tool_calls: 0, errors: 0, loop_warnings: 0 },
        { data_dir: dataDir },
      ),
    ).toThrow(/run\.json not found/);
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

    // Verify run.json
    const meta = JSON.parse(readFileSync(run.paths.run_json, "utf-8"));
    expect(meta.spec_version).toBe(SPEC_VERSION);
    expect(meta.status).toBe("ok");
    expect(meta.counts.llm_calls).toBe(1);
    expect(meta.counts.tool_calls).toBe(1);

    // Verify events.jsonl
    const events = readFileSync(run.paths.events_jsonl, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(events).toHaveLength(4);
    expect(events[0].event_type).toBe("RUN_START");
    expect(events[1].event_type).toBe("LLM_CALL");
    expect(events[1].spec_version).toBe(SPEC_VERSION);
    expect(events[2].event_type).toBe("TOOL_CALL");
    expect(events[3].event_type).toBe("RUN_END");

    // Every event has all required fields
    for (const evt of events) {
      expect(evt).toHaveProperty("spec_version");
      expect(evt).toHaveProperty("event_id");
      expect(evt).toHaveProperty("run_id");
      expect(evt).toHaveProperty("event_type");
      expect(evt).toHaveProperty("ts");
      expect(evt).toHaveProperty("name");
      expect(evt).toHaveProperty("payload");
      expect(evt).toHaveProperty("meta");
    }
  });
});
