import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { SPEC_VERSION } from "../src/constants.js";
import { detectLoop } from "../src/loopdetect.js";
import { installValidatedRun } from "../src/storage.js";
import type { MaidaSpan, RunMeta } from "../src/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = join(HERE, "contracts");
const CI_WORKFLOW = join(HERE, "..", ".github", "workflows", "ci.yml");
const cleanupDirs: string[] = [];

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

afterEach(() => {
  cleanupDirs.forEach((path) => rmSync(path, { recursive: true, force: true }));
  cleanupDirs.length = 0;
});

describe("Python-owned current-main contract", () => {
  it("uses Python's trace version and main development channel", () => {
    const contract = readJson(join(CONTRACTS, "current-main.json"));
    const schemas = contract.schemas as Record<string, string>;
    const cli = contract.cli as Record<string, string>;

    expect(contract.engine_ref).not.toBe("main");
    expect(contract.engine_ref).toMatch(
      /^v\d+\.\d+\.\d+(?:(?:a|b|rc)\d+|\.post\d+)?$/,
    );
    expect(contract.action_ref).toBe("maida-ai/maida-assert@v5");
    expect(schemas.trace).toBe(SPEC_VERSION);
    expect(cli.primary_gate).toBe("run");
    expect(cli.legacy_gate).toBe("assert");
  });

  it("runs contract tests, build, and typecheck in repository CI", () => {
    const workflow = readFileSync(CI_WORKFLOW, "utf-8");

    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("npm run lint");
  });
});

describe("Python-owned loop conformance vectors", () => {
  const vectors = readJson(join(CONTRACTS, "conformance", "loop-vectors.json"));
  const cases = vectors.cases as Array<Record<string, unknown>>;

  it.each(cases)("$name", (testCase) => {
    expect(
      detectLoop(
        testCase.events as Array<Record<string, unknown>>,
        testCase.window as number,
        testCase.repetitions as number,
      ),
    ).toEqual(testCase.expected);
  });
});

describe("Python-owned trace validation vectors", () => {
  const vectors = readJson(
    join(CONTRACTS, "conformance", "trace-validation-vectors.json"),
  );
  const base = vectors.base as { meta: Record<string, unknown>; spans: Array<Record<string, unknown>> };
  const cases = vectors.cases as Array<Record<string, unknown>>;

  it.each(cases)("$name", (testCase) => {
    const meta = clone(base.meta);
    const spans = clone(base.spans);
    Object.assign(meta, testCase.meta_overrides ?? {});
    for (const [index, overrides] of Object.entries(
      (testCase.span_overrides ?? {}) as Record<string, Record<string, unknown>>,
    )) {
      Object.assign(spans[Number(index)], overrides);
    }
    for (const [spanIndex, eventOverrides] of Object.entries(
      (testCase.event_overrides ?? {}) as Record<
        string,
        Record<string, Record<string, unknown>>
      >,
    )) {
      const events = spans[Number(spanIndex)].events as Array<Record<string, unknown>>;
      for (const [eventIndex, overrides] of Object.entries(eventOverrides)) {
        Object.assign(events[Number(eventIndex)], overrides);
      }
    }

    const dataDir = join(tmpdir(), `maida-contract-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    cleanupDirs.push(dataDir);
    const install = () =>
      installValidatedRun(meta as unknown as RunMeta, spans as unknown as MaidaSpan[], {
        data_dir: dataDir,
      });

    if (testCase.expected_valid) {
      expect(install).not.toThrow();
    } else {
      expect(install).toThrow(/Run validation failed/);
    }
  });
});
