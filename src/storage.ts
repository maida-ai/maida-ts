/**
 * Local storage for Maida runs: run metadata (run.json) and append-only events (events.jsonl).
 * Mirrors the write-side of maida/maida/storage.py — Python is the source of truth.
 *
 * Layout: <data_dir>/runs/<run_id>/ with run.json and events.jsonl.
 */

import {
  appendFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  closeSync,
  fsyncSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

import type { MaidaConfig, MaidaEvent, RunCounts, RunMeta } from "./types.js";
import { SPEC_VERSION, defaultCounts } from "./constants.js";
import { utcNowIsoMsZ } from "./events.js";

const RUN_JSON = "run.json";
const EVENTS_JSONL = "events.jsonl";
const RUN_ID_MAX_LEN = 36;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validateRunId(runId: string): string {
  if (!runId || typeof runId !== "string") throw new Error("invalid run_id");
  const id = runId.trim();
  if (
    id.length > RUN_ID_MAX_LEN ||
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\")
  ) {
    throw new Error("invalid run_id");
  }
  if (!UUID_V4_RE.test(id)) throw new Error("invalid run_id");
  return id;
}

function runsDir(config: Pick<MaidaConfig, "data_dir">): string {
  return join(config.data_dir, "runs");
}

function runDir(runId: string, config: Pick<MaidaConfig, "data_dir">): string {
  validateRunId(runId);
  const base = runsDir(config);
  const path = join(base, runId);
  const resolvedPath = resolve(path);
  const resolvedBase = resolve(base);
  const rel = relative(resolvedBase, resolvedPath);
  if (rel.startsWith("..") || rel.includes("..")) {
    throw new Error("invalid run_id");
  }
  return path;
}

function atomicWriteJson(filePath: string, data: Record<string, unknown>): void {
  const dir = join(filePath, "..");
  const tmp = join(dir, `.run.json.${randomUUID()}.tmp`);
  try {
    const content = JSON.stringify(data, null, 2);
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, content, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw e;
  }
}

export function createRun(
  runName: string | null,
  config: Pick<MaidaConfig, "data_dir">,
): RunMeta & { paths: { run_dir: string; run_json: string; events_jsonl: string } } {
  const runId = randomUUID();
  const dir = runDir(runId, config);
  mkdirSync(dir, { recursive: true });

  const startedAt = utcNowIsoMsZ();
  const meta: RunMeta = {
    spec_version: SPEC_VERSION,
    run_id: runId,
    run_name: runName,
    started_at: startedAt,
    ended_at: null,
    duration_ms: null,
    status: "running",
    counts: defaultCounts(),
    last_event_ts: null,
  };

  const runJsonPath = join(dir, RUN_JSON);
  atomicWriteJson(runJsonPath, meta as unknown as Record<string, unknown>);

  return {
    ...meta,
    paths: {
      run_dir: dir,
      run_json: runJsonPath,
      events_jsonl: join(dir, EVENTS_JSONL),
    },
  };
}

export function appendEvent(
  runId: string,
  event: MaidaEvent | Record<string, unknown>,
  config: Pick<MaidaConfig, "data_dir">,
): void {
  const dir = runDir(runId, config);
  const eventsPath = join(dir, EVENTS_JSONL);
  const line = JSON.stringify(event) + "\n";
  const fd = openSync(eventsPath, "a");
  try {
    writeFileSync(fd, line, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function finalizeRun(
  runId: string,
  status: "ok" | "error",
  counts: RunCounts,
  config: Pick<MaidaConfig, "data_dir">,
): void {
  const dir = runDir(runId, config);
  const runJsonPath = join(dir, RUN_JSON);

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(runJsonPath, "utf-8"));
  } catch {
    throw new Error(`run.json not found for run_id=${runId}`);
  }

  const endedAt = utcNowIsoMsZ();
  const startedAt = (meta.started_at as string) || endedAt;

  const startMs = new Date(startedAt.replace("Z", "+00:00")).getTime();
  const endMs = new Date(endedAt.replace("Z", "+00:00")).getTime();
  const durationMs = Math.max(0, endMs - startMs);

  const mergedCounts = defaultCounts();
  for (const k of Object.keys(mergedCounts) as (keyof RunCounts)[]) {
    if (k in counts && typeof counts[k] === "number") {
      mergedCounts[k] = Math.trunc(counts[k]);
    }
  }

  meta.ended_at = endedAt;
  meta.duration_ms = durationMs;
  meta.status = status;
  meta.counts = mergedCounts;
  meta.last_event_ts = endedAt;

  atomicWriteJson(runJsonPath, meta);
}
