/**
 * Configuration loading for the Maida TypeScript mirror.
 * Mirrors maida/maida/config.py — Python is the source of truth.
 *
 * Reads ~/.maida/config.yaml (user) and <projectRoot>/.maida/config.yaml (project),
 * then applies env var overrides. Same precedence: env > project > user > defaults.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { MaidaConfig, GuardrailParams } from "./types.js";

const DEFAULT_REDACT = true;
const DEFAULT_REDACT_KEYS = [
  "api_key",
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
];
const DEFAULT_MAX_FIELD_BYTES = 20000;
const DEFAULT_LOOP_WINDOW = 12;
const DEFAULT_LOOP_REPETITIONS = 3;

const MIN_MAX_FIELD_BYTES = 100;
const MIN_LOOP_WINDOW = 4;
const MIN_LOOP_REPETITIONS = 2;

function loadYaml(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const data = yaml.load(readFileSync(path, "utf-8"));
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function applyYaml<T>(config: Record<string, unknown>, key: string, fallback: T): T {
  if (!(key in config)) return fallback;
  const val = config[key];
  switch (key) {
    case "redact":
      return (val != null ? Boolean(val) : fallback) as T;
    case "redact_keys":
      if (Array.isArray(val) && val.every((x) => typeof x === "string"))
        return [...val] as T;
      return fallback;
    case "max_field_bytes": {
      const n = Number(val);
      return (Number.isFinite(n) ? Math.max(MIN_MAX_FIELD_BYTES, Math.trunc(n)) : fallback) as T;
    }
    case "loop_window": {
      const n = Number(val);
      return (Number.isFinite(n) ? Math.max(MIN_LOOP_WINDOW, Math.trunc(n)) : fallback) as T;
    }
    case "loop_repetitions": {
      const n = Number(val);
      return (Number.isFinite(n) ? Math.max(MIN_LOOP_REPETITIONS, Math.trunc(n)) : fallback) as T;
    }
    case "data_dir":
      return (val != null ? String(val) : fallback) as T;
    default:
      return fallback;
  }
}

function defaultGuardrails(): GuardrailParams {
  return {
    stop_on_loop: false,
    stop_on_loop_min_repetitions: 3,
    max_llm_calls: null,
    max_tool_calls: null,
    max_events: null,
    max_duration_s: null,
  };
}

function guardrailsFromDict(data: unknown): GuardrailParams {
  if (data == null || typeof data !== "object" || Array.isArray(data))
    return defaultGuardrails();
  const d = data as Record<string, unknown>;

  const g = defaultGuardrails();
  g.stop_on_loop = Boolean(d.stop_on_loop ?? false);

  const solmr = Number(d.stop_on_loop_min_repetitions);
  if (Number.isFinite(solmr)) g.stop_on_loop_min_repetitions = Math.max(2, Math.trunc(solmr));

  for (const key of ["max_llm_calls", "max_tool_calls", "max_events"] as const) {
    const v = d[key];
    if (v != null) {
      const n = Number(v);
      if (Number.isFinite(n)) (g as unknown as Record<string, unknown>)[key] = Math.max(0, Math.trunc(n));
    }
  }
  if (d.max_duration_s != null) {
    const n = Number(d.max_duration_s);
    if (Number.isFinite(n)) g.max_duration_s = Math.max(0, n);
  }
  return g;
}

function envTruthy(val: string): boolean {
  return ["1", "true", "yes"].includes(val.trim().toLowerCase());
}

function applyEnvToGuardrails(params: GuardrailParams): GuardrailParams {
  const g = { ...params };
  const env = process.env;

  if (env.MAIDA_STOP_ON_LOOP != null)
    g.stop_on_loop = envTruthy(env.MAIDA_STOP_ON_LOOP);

  if (env.MAIDA_STOP_ON_LOOP_MIN_REPETITIONS != null) {
    const n = Number(env.MAIDA_STOP_ON_LOOP_MIN_REPETITIONS);
    if (Number.isFinite(n)) g.stop_on_loop_min_repetitions = Math.max(2, Math.trunc(n));
  }

  for (const [envKey, field] of [
    ["MAIDA_MAX_LLM_CALLS", "max_llm_calls"],
    ["MAIDA_MAX_TOOL_CALLS", "max_tool_calls"],
    ["MAIDA_MAX_EVENTS", "max_events"],
  ] as const) {
    if (env[envKey] != null) {
      const n = Number(env[envKey]);
      if (Number.isFinite(n)) (g as Record<string, unknown>)[field] = Math.max(0, Math.trunc(n));
    }
  }

  if (env.MAIDA_MAX_DURATION_S != null) {
    const n = Number(env.MAIDA_MAX_DURATION_S);
    if (Number.isFinite(n)) g.max_duration_s = Math.max(0, n);
  }

  return g;
}

export function loadConfig(projectRoot?: string): MaidaConfig {
  const home = homedir();
  const base = join(home, ".maida");

  let redact = DEFAULT_REDACT;
  let redactKeys = [...DEFAULT_REDACT_KEYS];
  let maxFieldBytes = DEFAULT_MAX_FIELD_BYTES;
  let loopWindow = DEFAULT_LOOP_WINDOW;
  let loopRepetitions = DEFAULT_LOOP_REPETITIONS;
  let dataDir = base;
  let guardrails = defaultGuardrails();

  // User config
  const userCfg = loadYaml(join(base, "config.yaml"));
  if (Object.keys(userCfg).length) {
    redact = applyYaml(userCfg, "redact", redact);
    redactKeys = applyYaml(userCfg, "redact_keys", redactKeys);
    maxFieldBytes = applyYaml(userCfg, "max_field_bytes", maxFieldBytes);
    loopWindow = applyYaml(userCfg, "loop_window", loopWindow);
    loopRepetitions = applyYaml(userCfg, "loop_repetitions", loopRepetitions);
    dataDir = applyYaml(userCfg, "data_dir", dataDir);
    if ("guardrails" in userCfg) guardrails = guardrailsFromDict(userCfg.guardrails);
  }

  // Project config (overrides user)
  const root = projectRoot ?? process.cwd();
  const projCfg = loadYaml(join(root, ".maida", "config.yaml"));
  if (Object.keys(projCfg).length) {
    redact = applyYaml(projCfg, "redact", redact);
    redactKeys = applyYaml(projCfg, "redact_keys", redactKeys);
    maxFieldBytes = applyYaml(projCfg, "max_field_bytes", maxFieldBytes);
    loopWindow = applyYaml(projCfg, "loop_window", loopWindow);
    loopRepetitions = applyYaml(projCfg, "loop_repetitions", loopRepetitions);
    dataDir = applyYaml(projCfg, "data_dir", dataDir);
    if ("guardrails" in projCfg) guardrails = guardrailsFromDict(projCfg.guardrails);
  }

  // Env overrides
  const env = process.env;

  if (env.MAIDA_REDACT != null) redact = envTruthy(env.MAIDA_REDACT);

  if (env.MAIDA_REDACT_KEYS != null) {
    redactKeys = env.MAIDA_REDACT_KEYS.split(",")
      .map((k) => k.trim())
      .filter(Boolean);
  }

  if (env.MAIDA_MAX_FIELD_BYTES != null) {
    const n = Number(env.MAIDA_MAX_FIELD_BYTES);
    if (Number.isFinite(n)) maxFieldBytes = Math.max(MIN_MAX_FIELD_BYTES, Math.trunc(n));
  }

  if (env.MAIDA_LOOP_WINDOW != null) {
    const n = Number(env.MAIDA_LOOP_WINDOW);
    if (Number.isFinite(n)) loopWindow = Math.max(MIN_LOOP_WINDOW, Math.trunc(n));
  }

  if (env.MAIDA_LOOP_REPETITIONS != null) {
    const n = Number(env.MAIDA_LOOP_REPETITIONS);
    if (Number.isFinite(n)) loopRepetitions = Math.max(MIN_LOOP_REPETITIONS, Math.trunc(n));
  }

  if (env.MAIDA_DATA_DIR != null) {
    const v = env.MAIDA_DATA_DIR.trim();
    if (v) dataDir = v.startsWith("~") ? join(home, v.slice(1)) : v;
  }

  guardrails = applyEnvToGuardrails(guardrails);

  // Plugin-only: MAIDA_ENABLED
  let enabled = true;
  if (env.MAIDA_ENABLED != null) {
    enabled = envTruthy(env.MAIDA_ENABLED);
  }

  return {
    redact,
    redact_keys: redactKeys,
    max_field_bytes: maxFieldBytes,
    loop_window: loopWindow,
    loop_repetitions: loopRepetitions,
    data_dir: dataDir,
    guardrails,
    enabled,
  };
}
