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

export interface RunCounts {
  llm_calls: number;
  tool_calls: number;
  errors: number;
  loop_warnings: number;
}

export interface RunMeta {
  spec_version: string;
  run_id: string;
  run_name: string | null;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  status: string;
  counts: RunCounts;
  last_event_ts: string | null;
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
