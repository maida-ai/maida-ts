import { describe, it, expect, afterEach } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { SPEC_VERSION } from "../src/constants.js";
import { loadValidatedRun } from "../src/storage.js";
import type { MaidaSpan, RunMeta } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "fixtures", "traces");

const CURRENT_FIXTURES = {
  normal: "30000000000000000000000000000001",
  "tool-loop": "30000000000000000000000000000002",
  "missing-terminal-state": "30000000000000000000000000000003",
} as const;

const MALFORMED_FIXTURES = {
  "invalid-spans": "40000000000000000000000000000001",
} as const;

const REQUIRED_META_FIELDS = [
  "spec_version",
  "trace_id",
  "run_name",
  "started_at",
  "ended_at",
  "duration_ms",
  "status",
  "counts",
] as const;

const REQUIRED_SPAN_FIELDS = [
  "trace_id",
  "span_id",
  "parent_span_id",
  "name",
  "kind",
  "start_time",
  "end_time",
  "duration_ms",
  "attributes",
  "events",
  "status_code",
  "status_description",
] as const;

function makeTmpDataDir(): string {
  const dir = join(tmpdir(), `maida-fixture-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.length = 0;
});

function fixtureDir(group: "current" | "malformed", name: string): string {
  return join(FIXTURE_ROOT, group, name);
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function installFixture(
  group: "current" | "malformed",
  name: string,
  traceId: string,
): string {
  const dataDir = makeTmpDataDir();
  cleanupDirs.push(dataDir);
  const dest = join(dataDir, "runs", traceId);
  mkdirSync(join(dataDir, "runs"), { recursive: true });
  cpSync(fixtureDir(group, name), dest, { recursive: true });
  return dataDir;
}

function expectDocumentedFixture(group: "current" | "malformed", name: string): void {
  const dir = fixtureDir(group, name);
  expect(existsSync(join(dir, "README.md"))).toBe(true);
  expect(existsSync(join(dir, "meta.json"))).toBe(true);
  expect(existsSync(join(dir, "spans.jsonl"))).toBe(true);
}

function expectMetaShape(meta: Record<string, unknown>, traceId: string): void {
  for (const field of REQUIRED_META_FIELDS) {
    expect(meta).toHaveProperty(field);
  }
  expect(meta.spec_version).toBe(SPEC_VERSION);
  expect(meta.trace_id).toBe(traceId);
  expect(meta.status).toMatch(/^(running|ok|error)$/);
  expect(meta.counts).toEqual(
    expect.objectContaining({
      llm_calls: expect.any(Number),
      tool_calls: expect.any(Number),
      errors: expect.any(Number),
      loop_warnings: expect.any(Number),
    }),
  );
}

function expectSpanShape(span: MaidaSpan, traceId: string): void {
  for (const field of REQUIRED_SPAN_FIELDS) {
    expect(span).toHaveProperty(field);
  }
  expect(span).not.toHaveProperty("spec_version");
  expect(span.trace_id).toBe(traceId);
  expect(span.span_id).toMatch(/^[0-9a-f]{16}$/);
  if (span.parent_span_id !== null) {
    expect(span.parent_span_id).toMatch(/^[0-9a-f]{16}$/);
  }
  expect(span.attributes).toEqual(expect.any(Object));
  expect(Array.isArray(span.events)).toBe(true);
}

function expectLoadedFixture(name: keyof typeof CURRENT_FIXTURES): {
  meta: RunMeta;
  spans: MaidaSpan[];
} {
  const traceId = CURRENT_FIXTURES[name];
  expectDocumentedFixture("current", name);

  const meta = readJson(join(fixtureDir("current", name), "meta.json"));
  expectMetaShape(meta, traceId);

  const rawSpans = readJsonl(join(fixtureDir("current", name), "spans.jsonl"));
  expect(rawSpans.length).toBeGreaterThan(0);
  for (const span of rawSpans) {
    for (const field of REQUIRED_SPAN_FIELDS) {
      expect(span).toHaveProperty(field);
    }
    expect(span).not.toHaveProperty("spec_version");
    expect(span.trace_id).toBe(traceId);
  }

  const dataDir = installFixture("current", name, traceId);
  const loaded = loadValidatedRun(traceId, { data_dir: dataDir });
  expect(loaded.meta.trace_id).toBe(traceId);
  for (const span of loaded.spans) {
    expectSpanShape(span, traceId);
  }
  return loaded;
}

describe("cross-repo trace fixtures", () => {
  it("validates every current fixture with loadValidatedRun", () => {
    for (const name of Object.keys(CURRENT_FIXTURES) as (keyof typeof CURRENT_FIXTURES)[]) {
      expectLoadedFixture(name);
    }
  });

  it("documents the expected normal run shape", () => {
    const { meta, spans } = expectLoadedFixture("normal");

    expect(meta.run_name).toBe("ts-normal");
    expect(meta.status).toBe("ok");
    expect(meta.counts).toEqual({
      llm_calls: 1,
      tool_calls: 1,
      errors: 0,
      loop_warnings: 0,
    });

    const roots = spans.filter((span) => span.parent_span_id === null);
    expect(roots).toHaveLength(1);
    const llmSpan = spans.find((span) => span.attributes["gen_ai.request.model"] === "gpt-4o-mini");
    expect(llmSpan?.attributes["gen_ai.usage.total_tokens"]).toBe(25);
    const toolSpan = spans.find((span) => span.attributes["maida.tool_name"] === "search");
    expect(toolSpan?.events.map((event) => event.name)).toEqual([
      "maida.tool.args",
      "maida.tool.result",
    ]);
  });

  it("documents the expected tool-loop signature", () => {
    const { meta, spans } = expectLoadedFixture("tool-loop");

    expect(meta.counts.tool_calls).toBe(3);
    expect(meta.counts.loop_warnings).toBe(1);
    const toolSpans = spans.filter((span) => span.attributes["maida.tool_name"] === "lookup");
    expect(toolSpans).toHaveLength(3);

    const root = spans.find((span) => span.parent_span_id === null);
    const loopWarning = root?.events.find((event) => event.name === "maida.loop.warning");
    expect(loopWarning?.attributes).toEqual(
      expect.objectContaining({
        pattern: "TOOL_CALL:lookup",
        repetitions: 3,
        window_size: 3,
      }),
    );
    expect(loopWarning?.attributes.evidence_event_ids).toEqual(
      toolSpans.map((span) => span.span_id),
    );
  });

  it("documents the missing-terminal-state running trace", () => {
    const { meta, spans } = expectLoadedFixture("missing-terminal-state");

    expect(meta.status).toBe("running");
    expect(meta.ended_at).toBeNull();
    expect(meta.duration_ms).toBeNull();
    expect(spans.every((span) => span.parent_span_id !== null)).toBe(true);
    expect(spans).toHaveLength(1);
    expect(spans[0].end_time).toBeNull();
    expect(spans[0].status_code).toBe("UNSET");
  });

  it("documents and rejects the malformed invalid-spans fixture", () => {
    const name = "invalid-spans";
    const traceId = MALFORMED_FIXTURES[name];
    expectDocumentedFixture("malformed", name);
    expect(readFileSync(join(fixtureDir("malformed", name), "README.md"), "utf-8")).toContain(
      "Intentionally malformed",
    );

    const dataDir = installFixture("malformed", name, traceId);
    expect(() => loadValidatedRun(traceId, { data_dir: dataDir })).toThrow(/malformed JSON/);
  });

  it("keeps fixture directories limited to the documented cases", () => {
    expect(readdirSync(join(FIXTURE_ROOT, "current")).sort()).toEqual(
      Object.keys(CURRENT_FIXTURES).sort(),
    );
    expect(readdirSync(join(FIXTURE_ROOT, "malformed")).sort()).toEqual(
      Object.keys(MALFORMED_FIXTURES).sort(),
    );
  });
});
