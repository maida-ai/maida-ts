/**
 * Local storage for current Maida traces: metadata (meta.json) and append-only spans (spans.jsonl).
 * Mirrors the write-side of maida/maida/storage.py — Python is the source of truth.
 *
 * Layout: <data_dir>/runs/<trace_id>/ with meta.json and spans.jsonl.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import type { MaidaConfig, MaidaEvent, MaidaSpan, RunCounts, RunMeta } from "./types.js";
import { SPEC_VERSION, defaultCounts } from "./constants.js";
import { utcNowIsoMsZ } from "./events.js";
import { redactAndTruncate } from "./redact.js";

const META_JSON = "meta.json";
const SPANS_JSONL = "spans.jsonl";
const RUN_JSON = "run.json";
const EVENTS_JSONL = "events.jsonl";
const RUN_ID_MAX_LEN = 36;
const TRACE_ID_LEN = 32;
const SPAN_ID_LEN = 16;

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_RE = /^[0-9a-f]+$/;

type StorageConfig = Pick<MaidaConfig, "data_dir"> &
  Partial<Pick<MaidaConfig, "redact" | "redact_keys" | "max_field_bytes">>;

export interface RunPaths {
  run_dir: string;
  meta_json: string;
  spans_jsonl: string;
  /**
   * Legacy path aliases. They are returned for old callers, but current-format
   * createRun/finalizeRun do not write these files.
   */
  run_json: string;
  events_jsonl: string;
}

export interface CreatedRun extends RunMeta {
  trace_id: string;
  run_id: string;
  paths: RunPaths;
}

export interface ValidatedRun {
  meta: RunMeta;
  spans: MaidaSpan[];
}

const DEFAULT_REDACT_CONFIG = {
  redact: true,
  redact_keys: ["api_key", "authorization", "cookie", "password", "secret", "token"],
  max_field_bytes: 20000,
};
const NON_SECRET_ATTRIBUTE_KEYS = new Set([
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.total_tokens",
]);

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

export function validateTraceId(traceId: string): string {
  if (!traceId || typeof traceId !== "string") throw new Error("invalid trace_id");
  const id = traceId.trim().toLowerCase();
  if (
    id.length !== TRACE_ID_LEN ||
    !HEX_RE.test(id) ||
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\")
  ) {
    throw new Error("invalid trace_id");
  }
  return id;
}

function validateSpanId(spanId: string, fieldName: string): string {
  if (!spanId || typeof spanId !== "string") throw new Error(`invalid ${fieldName}`);
  const id = spanId.trim().toLowerCase();
  if (id.length !== SPAN_ID_LEN || !HEX_RE.test(id)) throw new Error(`invalid ${fieldName}`);
  return id;
}

function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

function runsDir(config: Pick<MaidaConfig, "data_dir">): string {
  return join(config.data_dir, "runs");
}

function traceDir(traceId: string, config: Pick<MaidaConfig, "data_dir">): string {
  const id = validateTraceId(traceId);
  const base = runsDir(config);
  const path = join(base, id);
  const resolvedPath = resolve(path);
  const resolvedBase = resolve(base);
  const rel = relative(resolvedBase, resolvedPath);
  if (rel.startsWith("..") || rel.includes("..")) {
    throw new Error("invalid trace_id");
  }
  return path;
}

function legacyRunDir(runId: string, config: Pick<MaidaConfig, "data_dir">): string {
  if (!runId || typeof runId !== "string") throw new Error("invalid run_id");
  const id = runId.trim();
  if (!id || id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error("invalid run_id");
  }
  return join(runsDir(config), id);
}

function atomicWriteJson(filePath: string, data: Record<string, unknown>): void {
  const dir = join(filePath, "..");
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${filePath.split("/").pop()}.${randomUUID()}.tmp`);
  try {
    const content = `${JSON.stringify(data, null, 2)}\n`;
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

function parseIsoMs(ts: unknown): number | null {
  if (typeof ts !== "string" || !ts.trim()) return null;
  const n = new Date(ts.replace("Z", "+00:00")).getTime();
  return Number.isFinite(n) ? n : null;
}

function mergedRedactConfig(config: StorageConfig) {
  return {
    redact: config.redact ?? DEFAULT_REDACT_CONFIG.redact,
    redact_keys: config.redact_keys ?? DEFAULT_REDACT_CONFIG.redact_keys,
    max_field_bytes: config.max_field_bytes ?? DEFAULT_REDACT_CONFIG.max_field_bytes,
  };
}

function sanitizeAttributes(
  attrs: Record<string, unknown>,
  config: StorageConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const redactConfig = mergedRedactConfig(config);
  for (const [key, value] of Object.entries(attrs)) {
    if (NON_SECRET_ATTRIBUTE_KEYS.has(key)) {
      out[key] = redactAndTruncate(value, { ...redactConfig, redact: false });
      continue;
    }
    const redacted = redactAndTruncate({ [key]: value }, redactConfig);
    if (redacted && typeof redacted === "object" && !Array.isArray(redacted) && key in redacted) {
      out[key] = (redacted as Record<string, unknown>)[key];
    } else {
      out[key] = redactAndTruncate(value, redactConfig);
    }
  }
  return out;
}

function sanitizeSpan(span: MaidaSpan, config: StorageConfig): MaidaSpan {
  return {
    ...span,
    attributes: sanitizeAttributes(span.attributes ?? {}, config),
    events: (span.events ?? []).map((event) => ({
      name: String(event.name ?? ""),
      timestamp: typeof event.timestamp === "string" ? event.timestamp : utcNowIsoMsZ(),
      attributes: sanitizeAttributes(event.attributes ?? {}, config),
    })),
    status_description: String(
      redactAndTruncate(span.status_description ?? "", mergedRedactConfig(config)),
    ),
  };
}

function isEventLike(value: MaidaEvent | Record<string, unknown>): value is MaidaEvent {
  return "event_type" in value && "payload" in value;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function eventToSpan(traceId: string, event: MaidaEvent | Record<string, unknown>): MaidaSpan {
  const now = utcNowIsoMsZ();
  if (!isEventLike(event)) {
    return normalizeSpan(traceId, event);
  }

  const payload = payloadRecord(event.payload);
  const meta = payloadRecord(event.meta);
  const eventType = String(event.event_type);
  const startTime = typeof event.ts === "string" ? event.ts : now;
  const durationMs = typeof event.duration_ms === "number" ? Math.max(0, Math.trunc(event.duration_ms)) : null;
  const endTime =
    durationMs === null
      ? startTime
      : new Date((parseIsoMs(startTime) ?? Date.now()) + durationMs).toISOString();

  const attrs: Record<string, unknown> = {
    "maida.event_type": eventType,
    "maida.meta": JSON.stringify(meta),
  };
  const spanEvents: MaidaSpan["events"] = [];
  let name = String(event.name ?? "");
  let statusCode: MaidaSpan["status_code"] = "UNSET";
  let statusDescription = "";
  let parentSpanId: string | null =
    typeof event.parent_id === "string" && event.parent_id.length === SPAN_ID_LEN
      ? event.parent_id
      : null;

  if (eventType === "RUN_START") {
    parentSpanId = null;
    attrs["maida.run_name"] = name;
  } else if (eventType === "RUN_END") {
    attrs["maida.run_name"] = name;
    const status = payload.status;
    statusCode = status === "error" ? "ERROR" : status === "ok" ? "OK" : "UNSET";
  } else if (eventType === "LLM_CALL") {
    attrs["gen_ai.system"] = payload.provider ?? "unknown";
    attrs["gen_ai.operation.name"] = "chat";
    attrs["gen_ai.request.model"] = payload.model ?? name;
    if (payload.temperature != null) attrs["gen_ai.request.temperature"] = payload.temperature;
    const usage = payloadRecord(payload.usage);
    if (typeof usage.prompt_tokens === "number") attrs["gen_ai.usage.input_tokens"] = usage.prompt_tokens;
    if (typeof usage.completion_tokens === "number") attrs["gen_ai.usage.output_tokens"] = usage.completion_tokens;
    if (typeof usage.total_tokens === "number") attrs["gen_ai.usage.total_tokens"] = usage.total_tokens;
    if (payload.prompt != null) {
      spanEvents.push({
        name: "gen_ai.user.message",
        timestamp: startTime,
        attributes: { content: payload.prompt },
      });
    }
    if (payload.response != null) {
      spanEvents.push({
        name: "gen_ai.assistant.message",
        timestamp: endTime,
        attributes: { content: payload.response },
      });
    }
    if (payload.status === "error" || payload.error != null) {
      statusCode = "ERROR";
      const error = payloadRecord(payload.error);
      attrs["maida.error_type"] = error.error_type ?? "Error";
      attrs["maida.error_message"] = error.message ?? "";
      attrs["maida.error_stack"] = error.stack ?? null;
      statusDescription = String(error.message ?? "");
    } else {
      statusCode = "OK";
    }
  } else if (eventType === "TOOL_CALL") {
    name = String(payload.tool_name ?? name);
    attrs["maida.tool_name"] = name;
    spanEvents.push({
      name: "maida.tool.args",
      timestamp: startTime,
      attributes: { args: JSON.stringify(payload.args ?? null) },
    });
    spanEvents.push({
      name: "maida.tool.result",
      timestamp: endTime,
      attributes: { result: JSON.stringify(payload.result ?? null) },
    });
    if (payload.status === "error" || payload.error != null) {
      statusCode = "ERROR";
      const error = payloadRecord(payload.error);
      attrs["maida.error_type"] = error.error_type ?? "Error";
      attrs["maida.error_message"] = error.message ?? "";
      attrs["maida.error_stack"] = error.stack ?? null;
      statusDescription = String(error.message ?? "");
    } else {
      statusCode = "OK";
    }
  } else if (eventType === "STATE_UPDATE") {
    name = "state";
    spanEvents.push({
      name: "state",
      timestamp: startTime,
      attributes: {
        state: JSON.stringify(payload.state ?? null),
        diff: JSON.stringify(payload.diff ?? null),
      },
    });
  } else if (eventType === "LOOP_WARNING") {
    name = "loop_warning";
    spanEvents.push({
      name: "maida.loop.warning",
      timestamp: startTime,
      attributes: payload,
    });
  } else if (eventType === "ERROR") {
    statusCode = "ERROR";
    attrs["maida.error_type"] = payload.error_type ?? "Error";
    attrs["maida.error_message"] = payload.message ?? "";
    attrs["maida.error_stack"] = payload.stack ?? null;
    statusDescription = String(payload.message ?? "");
  }

  return {
    spec_version: SPEC_VERSION,
    trace_id: traceId,
    span_id: validateSpanId(event.event_id?.replaceAll("-", "").slice(0, SPAN_ID_LEN) || newSpanId(), "span_id"),
    parent_span_id: parentSpanId,
    name,
    kind: "INTERNAL",
    start_time: startTime,
    end_time: endTime,
    duration_ms: durationMs,
    attributes: attrs,
    events: spanEvents,
    status_code: statusCode,
    status_description: statusDescription,
  };
}

function normalizeSpan(traceId: string, span: Record<string, unknown>): MaidaSpan {
  const start = typeof span.start_time === "string" ? span.start_time : utcNowIsoMsZ();
  return {
    spec_version: typeof span.spec_version === "string" ? span.spec_version : SPEC_VERSION,
    trace_id: validateTraceId(String(span.trace_id ?? traceId)),
    span_id: validateSpanId(String(span.span_id ?? newSpanId()), "span_id"),
    parent_span_id:
      span.parent_span_id === null || span.parent_span_id === undefined
        ? null
        : validateSpanId(String(span.parent_span_id), "parent_span_id"),
    name: String(span.name ?? ""),
    kind: String(span.kind ?? "INTERNAL"),
    start_time: start,
    end_time: span.end_time == null ? null : String(span.end_time),
    duration_ms:
      typeof span.duration_ms === "number" ? Math.max(0, Math.trunc(span.duration_ms)) : null,
    attributes: payloadRecord(span.attributes),
    events: Array.isArray(span.events)
      ? span.events.map((event) => {
          const ev = payloadRecord(event);
          return {
            name: String(ev.name ?? ""),
            timestamp: typeof ev.timestamp === "string" ? ev.timestamp : start,
            attributes: payloadRecord(ev.attributes),
          };
        })
      : [],
    status_code:
      span.status_code === "OK" || span.status_code === "ERROR" || span.status_code === "UNSET"
        ? span.status_code
        : "UNSET",
    status_description: String(span.status_description ?? ""),
  };
}

export function createRun(runName: string | null, config: Pick<MaidaConfig, "data_dir">): CreatedRun {
  const traceId = newTraceId();
  const dir = traceDir(traceId, config);
  mkdirSync(dir, { recursive: true });

  const startedAt = utcNowIsoMsZ();
  const meta: RunMeta = {
    spec_version: SPEC_VERSION,
    trace_id: traceId,
    run_name: runName,
    started_at: startedAt,
    ended_at: null,
    duration_ms: null,
    status: "running",
    counts: defaultCounts(),
  };

  const metaJsonPath = join(dir, META_JSON);
  atomicWriteJson(metaJsonPath, meta as unknown as Record<string, unknown>);
  closeSync(openSync(join(dir, SPANS_JSONL), "a"));

  return {
    ...meta,
    run_id: traceId,
    paths: {
      run_dir: dir,
      meta_json: metaJsonPath,
      spans_jsonl: join(dir, SPANS_JSONL),
      run_json: join(dir, RUN_JSON),
      events_jsonl: join(dir, EVENTS_JSONL),
    },
  };
}

export function appendSpan(
  traceId: string,
  span: MaidaSpan | Record<string, unknown>,
  config: StorageConfig,
): void {
  const id = validateTraceId(traceId);
  const dir = traceDir(id, config);
  mkdirSync(dir, { recursive: true });
  const normalized = normalizeSpan(id, span as Record<string, unknown>);
  const safeSpan = sanitizeSpan(normalized, config);
  appendFileSync(join(dir, SPANS_JSONL), `${JSON.stringify(safeSpan)}\n`, "utf-8");
}

export function appendEvent(
  traceId: string,
  event: MaidaEvent | Record<string, unknown>,
  config: StorageConfig,
): void {
  const id = validateTraceId(traceId);
  const dir = traceDir(id, config);
  mkdirSync(dir, { recursive: true });
  const safeSpan = sanitizeSpan(eventToSpan(id, event), config);
  appendFileSync(join(dir, SPANS_JSONL), `${JSON.stringify(safeSpan)}\n`, "utf-8");
}

export function appendLegacyEvent(
  runId: string,
  event: MaidaEvent | Record<string, unknown>,
  config: Pick<MaidaConfig, "data_dir">,
): void {
  const dir = legacyRunDir(runId, config);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, EVENTS_JSONL), `${JSON.stringify(event)}\n`, "utf-8");
}

function readMeta(traceId: string, config: Pick<MaidaConfig, "data_dir">): Record<string, unknown> {
  const path = join(traceDir(traceId, config), META_JSON);
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error(`meta.json not found for trace_id=${traceId}`);
  }
}

function rootSpanForMeta(meta: Record<string, unknown>, status: "ok" | "error"): MaidaSpan {
  const traceId = validateTraceId(String(meta.trace_id));
  const startedAt = typeof meta.started_at === "string" ? meta.started_at : utcNowIsoMsZ();
  const endedAt = typeof meta.ended_at === "string" ? meta.ended_at : utcNowIsoMsZ();
  const durationMs = typeof meta.duration_ms === "number" ? meta.duration_ms : null;
  const counts = payloadRecord(meta.counts);
  return {
    spec_version: SPEC_VERSION,
    trace_id: traceId,
    span_id: newSpanId(),
    parent_span_id: null,
    name: String(meta.run_name ?? ""),
    kind: "INTERNAL",
    start_time: startedAt,
    end_time: endedAt,
    duration_ms: durationMs,
    attributes: {
      "maida.run_name": meta.run_name ?? null,
      "maida.status": status,
      "maida.llm_calls": counts.llm_calls ?? 0,
      "maida.tool_calls": counts.tool_calls ?? 0,
      "maida.errors": counts.errors ?? 0,
      "maida.loop_warnings": counts.loop_warnings ?? 0,
    },
    events: [],
    status_code: status === "ok" ? "OK" : "ERROR",
    status_description: "",
  };
}

export function finalizeRun(
  traceId: string,
  status: "ok" | "error",
  counts: RunCounts,
  config: StorageConfig,
): void {
  const id = validateTraceId(traceId);
  const dir = traceDir(id, config);
  const metaJsonPath = join(dir, META_JSON);
  const meta = readMeta(id, config);

  const endedAt = utcNowIsoMsZ();
  const startMs = parseIsoMs(meta.started_at) ?? parseIsoMs(endedAt) ?? Date.now();
  const endMs = parseIsoMs(endedAt) ?? startMs;
  const durationMs = Math.max(0, endMs - startMs);

  const mergedCounts = defaultCounts();
  for (const k of Object.keys(mergedCounts) as (keyof RunCounts)[]) {
    if (k in counts && typeof counts[k] === "number") {
      mergedCounts[k] = Math.max(0, Math.trunc(counts[k]));
    }
  }

  meta.spec_version = SPEC_VERSION;
  meta.trace_id = id;
  meta.ended_at = endedAt;
  meta.duration_ms = durationMs;
  meta.status = status;
  meta.counts = mergedCounts;

  atomicWriteJson(metaJsonPath, meta);
  appendSpan(id, rootSpanForMeta(meta, status), config);
}

function validationError(traceId: string, problem: string): Error {
  return new Error(
    `Run validation failed for ${traceId.slice(0, 8)}: ${problem}. Next step: rerun the traced agent to create a fresh run.`,
  );
}

function readSpansForValidation(traceId: string, config: Pick<MaidaConfig, "data_dir">): MaidaSpan[] {
  const path = join(traceDir(traceId, config), SPANS_JSONL);
  if (!existsSync(path)) throw validationError(traceId, "required file spans.jsonl is missing");
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw validationError(traceId, "spans.jsonl contains no spans");
  return lines.map((line, index) => {
    try {
      const span = JSON.parse(line);
      if (!span || typeof span !== "object" || Array.isArray(span)) {
        throw validationError(traceId, `spans.jsonl line ${index + 1} must contain a JSON object`);
      }
      return normalizeSpan(traceId, span as Record<string, unknown>);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Run validation failed")) throw e;
      throw validationError(traceId, `spans.jsonl line ${index + 1} is malformed JSON`);
    }
  });
}

function validateCounts(traceId: string, counts: unknown): asserts counts is RunCounts {
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw validationError(traceId, "meta.json field 'counts' must be an object");
  }
  const obj = counts as Record<string, unknown>;
  for (const key of ["llm_calls", "tool_calls", "errors", "loop_warnings"]) {
    const value = obj[key];
    if (!Number.isInteger(value) || (value as number) < 0) {
      throw validationError(traceId, `meta.json counts.${key} must be a non-negative integer`);
    }
  }
}

export function loadValidatedRun(
  traceId: string,
  config: Pick<MaidaConfig, "data_dir">,
): ValidatedRun {
  const id = validateTraceId(traceId);
  const dir = traceDir(id, config);
  if (!existsSync(dir)) throw new Error(`No run found for trace_id '${id}'`);

  const metaPath = join(dir, META_JSON);
  if (!existsSync(metaPath)) throw validationError(id, "required file meta.json is missing");

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    throw validationError(id, "meta.json is malformed JSON");
  }
  if (meta.spec_version != null && meta.spec_version !== SPEC_VERSION) {
    throw validationError(id, `meta.json declares unsupported spec_version '${String(meta.spec_version)}'`);
  }
  if (meta.trace_id !== id) {
    throw validationError(id, "meta.json trace_id does not match run directory");
  }
  validateCounts(id, meta.counts);
  if (meta.status !== "running" && meta.status !== "ok" && meta.status !== "error") {
    throw validationError(id, "meta.json field 'status' must be running, ok, or error");
  }

  const spans = readSpansForValidation(id, config);
  if (meta.status !== "running" && !spans.some((span) => span.parent_span_id === null)) {
    throw validationError(id, "spans.jsonl has no root span");
  }

  return {
    meta: {
      spec_version: String(meta.spec_version ?? SPEC_VERSION),
      trace_id: id,
      run_name: meta.run_name == null ? null : String(meta.run_name),
      started_at: String(meta.started_at ?? ""),
      ended_at: meta.ended_at == null ? null : String(meta.ended_at),
      duration_ms: typeof meta.duration_ms === "number" ? meta.duration_ms : null,
      status: String(meta.status),
      counts: meta.counts,
    },
    spans,
  };
}
