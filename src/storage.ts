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
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve, relative } from "node:path";
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
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i;
const SPAN_KINDS = new Set(["INTERNAL", "CLIENT", "SERVER", "PRODUCER", "CONSUMER"]);

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

/**
 * Derive a stable 16-char hex span id from an event id. Event ids are UUIDs
 * (or other identifiers); we strip dashes and take the leading 16 hex chars so
 * that a child event's `parent_id` resolves to the same span id the parent
 * event produced for itself. Returns null when no usable hex id can be derived.
 */
function eventIdToSpanId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const compact = raw.replaceAll("-", "").toLowerCase();
  if (compact.length < SPAN_ID_LEN) return null;
  const candidate = compact.slice(0, SPAN_ID_LEN);
  return HEX_RE.test(candidate) ? candidate : null;
}

/**
 * Deterministic span id for a run's synthetic root span, derived from the trace
 * id. Because it is stable, event-derived child spans can reference it as their
 * parent before finalizeRun writes the root span itself.
 */
function runRootSpanId(traceId: string): string {
  return traceId.slice(0, SPAN_ID_LEN);
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

function runPaths(traceId: string, config: Pick<MaidaConfig, "data_dir">): RunPaths {
  const dir = traceDir(traceId, config);
  return {
    run_dir: dir,
    meta_json: join(dir, META_JSON),
    spans_jsonl: join(dir, SPANS_JSONL),
    run_json: join(dir, RUN_JSON),
    events_jsonl: join(dir, EVENTS_JSONL),
  };
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
  const tmp = join(dir, `.${basename(filePath)}.${randomUUID()}.tmp`);
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

function traceVersionCompatible(declared: unknown): boolean {
  if (declared === "0.2") return true;
  if (typeof declared !== "string") return false;
  const candidate = SEMVER_RE.exec(declared);
  const current = SEMVER_RE.exec(SPEC_VERSION);
  return candidate !== null && current !== null && candidate[1] === current[1] && candidate[2] === current[2];
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
  // Default to the run root so unparented events nest under a single root
  // rather than each becoming a competing root span. An explicit parent_id
  // still wins.
  let parentSpanId: string | null = eventIdToSpanId(event.parent_id) ?? runRootSpanId(traceId);

  if (eventType === "RUN_START") {
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
    trace_id: traceId,
    span_id: validateSpanId(eventIdToSpanId(event.event_id) ?? newSpanId(), "span_id"),
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
  // Older TS-produced spans may include an additive span-level spec_version.
  // The current public contract keeps spec_version in meta.json only, so reads
  // tolerate and drop the span field instead of preserving it.
  return {
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
  const paths = runPaths(traceId, config);
  const dir = paths.run_dir;
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

  const metaJsonPath = paths.meta_json;
  atomicWriteJson(metaJsonPath, meta as unknown as Record<string, unknown>);
  closeSync(openSync(join(dir, SPANS_JSONL), "a"));

  return {
    ...meta,
    run_id: traceId,
    paths,
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
    trace_id: traceId,
    span_id: runRootSpanId(traceId),
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

function validationError(
  traceId: string,
  problem: string,
  nextStep = "rerun the traced agent to create a fresh run",
): Error {
  return new Error(
    `Run validation failed for ${traceId.slice(0, 8)}: ${problem}. Next step: ${nextStep}.`,
  );
}

function readSpansForValidation(
  traceId: string,
  config: Pick<MaidaConfig, "data_dir">,
  requireRoot: boolean,
): MaidaSpan[] {
  const path = join(traceDir(traceId, config), SPANS_JSONL);
  if (!existsSync(path)) throw validationError(traceId, "required file spans.jsonl is missing");
  const lines = readFileSync(path, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) throw validationError(traceId, "spans.jsonl contains no spans");
  const rawSpans = lines.map((line, index) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw validationError(traceId, `spans.jsonl line ${index + 1} is malformed JSON`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw validationError(traceId, `spans.jsonl line ${index + 1} must contain a JSON object`);
    }
    return raw as Record<string, unknown>;
  });
  validateInstallSpans(traceId, rawSpans as unknown as MaidaSpan[], requireRoot);
  return rawSpans.map((span) => normalizeSpan(traceId, span));
}

function isRfc3339(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = RFC3339_RE.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  if (offsetHour > 23 || offsetMinute > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysByMonth[month - 1];
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

function hasField(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function validateInstallMeta(traceId: string, value: RunMeta): void {
  const meta = value as unknown as Record<string, unknown>;
  const required = [
    "spec_version",
    "trace_id",
    "run_name",
    "started_at",
    "ended_at",
    "duration_ms",
    "status",
    "counts",
  ];
  for (const field of required) {
    if (!hasField(meta, field)) {
      throw validationError(traceId, `meta.json is missing field '${field}'`);
    }
  }
  if (!traceVersionCompatible(meta.spec_version)) {
    throw validationError(
      traceId,
      `meta.json declares unsupported spec_version '${String(meta.spec_version)}'`,
      `upgrade Maida or re-record this trace; the supported format is spec_version '${SPEC_VERSION}'`,
    );
  }
  if (meta.trace_id !== traceId) {
    throw validationError(traceId, "meta.json trace_id does not match run directory");
  }
  if (meta.run_name !== null && typeof meta.run_name !== "string") {
    throw validationError(traceId, "meta.json field 'run_name' must be a string or null");
  }
  if (!isRfc3339(meta.started_at)) {
    throw validationError(traceId, "meta.json field 'started_at' must be an RFC 3339 date-time with a timezone");
  }
  if (meta.ended_at !== null && !isRfc3339(meta.ended_at)) {
    throw validationError(traceId, "meta.json field 'ended_at' must be an RFC 3339 date-time or null");
  }
  if (
    meta.duration_ms !== null &&
    (!Number.isInteger(meta.duration_ms) || (meta.duration_ms as number) < 0)
  ) {
    throw validationError(
      traceId,
      "meta.json field 'duration_ms' must be a non-negative integer or null",
    );
  }
  if (meta.status !== "running" && meta.status !== "ok" && meta.status !== "error") {
    throw validationError(traceId, "meta.json field 'status' must be running, ok, or error");
  }
  validateCounts(traceId, meta.counts);
}

function validateInstallSpans(traceId: string, values: MaidaSpan[], requireRoot: boolean): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw validationError(traceId, "spans.jsonl contains no spans");
  }
  const required = [
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
  ];
  let roots = 0;
  const spanIds = new Set<string>();
  const parents = new Map<string, string | null>();
  values.forEach((value, index) => {
    const line = index + 1;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw validationError(traceId, `spans.jsonl line ${line} must contain a JSON object`);
    }
    const span = value as unknown as Record<string, unknown>;
    if (hasField(span, "trace_id") && (typeof span.trace_id !== "string" || span.trace_id !== traceId)) {
      throw validationError(traceId, `spans.jsonl line ${line} belongs to a different trace_id`);
    }
    if (hasField(span, "span_id")) {
      try {
        if (typeof span.span_id !== "string") throw new Error("invalid span_id");
        validateSpanId(span.span_id, "span_id");
      } catch {
        throw validationError(traceId, `spans.jsonl line ${line} has an invalid span_id`);
      }
    }
    if (hasField(span, "parent_span_id") && span.parent_span_id !== null) {
      try {
        if (typeof span.parent_span_id !== "string") {
          throw new Error("invalid parent_span_id");
        }
        validateSpanId(span.parent_span_id, "parent_span_id");
      } catch {
        throw validationError(traceId, `spans.jsonl line ${line} has an invalid parent_span_id`);
      }
    }
    for (const field of required) {
      if (!hasField(span, field)) {
        throw validationError(traceId, `spans.jsonl line ${line} is missing field '${field}'`);
      }
    }
    const spanId = String(span.span_id);
    if (spanIds.has(spanId)) {
      throw validationError(traceId, `spans.jsonl line ${line} duplicates an earlier span_id`);
    }
    spanIds.add(spanId);
    if (span.parent_span_id === null) {
      roots += 1;
    }
    parents.set(spanId, span.parent_span_id === null ? null : String(span.parent_span_id));
    for (const field of ["name", "status_description"]) {
      if (typeof span[field] !== "string") {
        throw validationError(traceId, `spans.jsonl line ${line} field '${field}' must be a string`);
      }
    }
    if (!SPAN_KINDS.has(String(span.kind))) {
      throw validationError(
        traceId,
        `spans.jsonl line ${line} field 'kind' must be INTERNAL, CLIENT, SERVER, PRODUCER, or CONSUMER`,
      );
    }
    if (!isRfc3339(span.start_time)) {
      throw validationError(
        traceId,
        `spans.jsonl line ${line} field 'start_time' must be an RFC 3339 date-time with a timezone`,
      );
    }
    if (span.end_time !== null && !isRfc3339(span.end_time)) {
      throw validationError(traceId, `spans.jsonl line ${line} field 'end_time' must be an RFC 3339 date-time or null`);
    }
    if (
      span.duration_ms !== null &&
      (!Number.isInteger(span.duration_ms) || (span.duration_ms as number) < 0)
    ) {
      throw validationError(
        traceId,
        `spans.jsonl line ${line} field 'duration_ms' must be a non-negative integer or null`,
      );
    }
    if (!span.attributes || typeof span.attributes !== "object" || Array.isArray(span.attributes)) {
      throw validationError(traceId, `spans.jsonl line ${line} field 'attributes' must be an object`);
    }
    if (!Array.isArray(span.events)) {
      throw validationError(traceId, `spans.jsonl line ${line} field 'events' must be an array`);
    }
    span.events.forEach((value, eventIndex) => {
      const event = value as Record<string, unknown>;
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw validationError(traceId, `spans.jsonl line ${line} event ${eventIndex + 1} must be an object`);
      }
      for (const field of ["name", "timestamp", "attributes"]) {
        if (!hasField(event, field)) {
          throw validationError(
            traceId,
            `spans.jsonl line ${line} event ${eventIndex + 1} is missing field '${field}'`,
          );
        }
      }
      if (typeof event.name !== "string") {
        throw validationError(
          traceId,
          `spans.jsonl line ${line} event ${eventIndex + 1} field 'name' must be a string`,
        );
      }
      if (!isRfc3339(event.timestamp)) {
        throw validationError(
          traceId,
          `spans.jsonl line ${line} event ${eventIndex + 1} field 'timestamp' must be an RFC 3339 date-time with a timezone`,
        );
      }
      if (!event.attributes || typeof event.attributes !== "object" || Array.isArray(event.attributes)) {
        throw validationError(
          traceId,
          `spans.jsonl line ${line} event ${eventIndex + 1} field 'attributes' must be an object`,
        );
      }
    });
    if (span.status_code !== "OK" && span.status_code !== "ERROR" && span.status_code !== "UNSET") {
      throw validationError(
        traceId,
        `spans.jsonl line ${line} field 'status_code' must be OK, ERROR, or UNSET`,
      );
    }
  });
  if (requireRoot && roots === 0) {
    throw validationError(traceId, "spans.jsonl has no root span");
  }
  if (roots > 1) {
    throw validationError(traceId, "spans.jsonl defines more than one root span");
  }
  if (requireRoot) {
    for (const [spanId, parent] of parents) {
      if (parent !== null && !spanIds.has(parent)) {
        throw validationError(traceId, `span ${spanId} references a parent_span_id not present in this trace`);
      }
    }
  }
  const inspected = new Set<string>();
  for (const start of parents.keys()) {
    if (inspected.has(start)) continue;
    const ordered: string[] = [];
    const positions = new Map<string, number>();
    let current: string | null = start;
    while (current !== null && parents.has(current)) {
      if (positions.has(current)) {
        throw validationError(traceId, `span ${current} participates in a parent_span_id cycle`);
      }
      if (inspected.has(current)) break;
      positions.set(current, ordered.length);
      ordered.push(current);
      current = parents.get(current) ?? null;
    }
    ordered.forEach((spanId) => inspected.add(spanId));
  }
}

export function installValidatedRun(
  meta: RunMeta,
  spans: MaidaSpan[],
  config: Pick<MaidaConfig, "data_dir">,
): RunPaths {
  const traceId = validateTraceId(meta?.trace_id);
  validateInstallMeta(traceId, meta);
  validateInstallSpans(traceId, spans, meta.status !== "running");

  const paths = runPaths(traceId, config);
  if (existsSync(paths.run_dir)) throw new Error(`Run ${traceId} already exists`);

  const runs = runsDir(config);
  mkdirSync(runs, { recursive: true });
  const staging = join(runs, `.${traceId}.${randomUUID()}.tmp`);
  mkdirSync(staging);
  try {
    atomicWriteJson(join(staging, META_JSON), meta as unknown as Record<string, unknown>);
    const spansPath = join(staging, SPANS_JSONL);
    const fd = openSync(spansPath, "w");
    try {
      for (const span of spans) {
        writeFileSync(fd, `${JSON.stringify(span)}\n`, "utf-8");
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existsSync(paths.run_dir)) throw new Error(`Run ${traceId} already exists`);
    renameSync(staging, paths.run_dir);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return paths;
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
  validateInstallMeta(id, meta as unknown as RunMeta);

  const spans = readSpansForValidation(id, config, meta.status !== "running");

  return {
    meta: {
      spec_version: String(meta.spec_version ?? SPEC_VERSION),
      trace_id: id,
      run_name: meta.run_name == null ? null : String(meta.run_name),
      started_at: String(meta.started_at ?? ""),
      ended_at: meta.ended_at == null ? null : String(meta.ended_at),
      duration_ms: typeof meta.duration_ms === "number" ? meta.duration_ms : null,
      status: String(meta.status),
      counts: meta.counts as RunCounts,
    },
    spans,
  };
}
