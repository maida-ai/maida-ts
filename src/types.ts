/**
 * All TypeScript interfaces for the Maida trace format.
 *
 * Two groups:
 * 1. Maida schema types — must match Python spec exactly
 * 2. Configuration types — mirror Python config/guardrails dataclasses
 */

export enum EventType {
  RUN_START = "RUN_START",
  RUN_END = "RUN_END",
  LLM_CALL = "LLM_CALL",
  TOOL_CALL = "TOOL_CALL",
  STATE_UPDATE = "STATE_UPDATE",
  ERROR = "ERROR",
  LOOP_WARNING = "LOOP_WARNING",
}

export interface MaidaEvent {
  spec_version: string;
  event_id: string;
  run_id: string;
  parent_id: string | null;
  event_type: string;
  ts: string;
  duration_ms: number | null;
  name: string;
  payload: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export interface MaidaSpanEvent {
  name: string;
  timestamp: string;
  attributes: Record<string, unknown>;
}

export interface MaidaSpan {
  spec_version?: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  start_time: string;
  end_time: string | null;
  duration_ms: number | null;
  attributes: Record<string, unknown>;
  events: MaidaSpanEvent[];
  status_code: "OK" | "ERROR" | "UNSET";
  status_description: string;
}

export interface RunCounts {
  llm_calls: number;
  tool_calls: number;
  errors: number;
  loop_warnings: number;
}

export interface RunMeta {
  spec_version: string;
  trace_id: string;
  /**
   * Compatibility alias for callers that still treat trace IDs as run IDs.
   * This is returned by TS helpers, but not written to current meta.json.
   */
  run_id?: string;
  run_name: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  status: string;
  counts: RunCounts;
}

export interface GuardrailParams {
  stop_on_loop: boolean;
  stop_on_loop_min_repetitions: number;
  max_llm_calls: number | null;
  max_tool_calls: number | null;
  max_events: number | null;
  max_duration_s: number | null;
}

export interface MaidaConfig {
  redact: boolean;
  redact_keys: string[];
  max_field_bytes: number;
  loop_window: number;
  loop_repetitions: number;
  data_dir: string;
  guardrails: GuardrailParams;
  enabled: boolean;
}
