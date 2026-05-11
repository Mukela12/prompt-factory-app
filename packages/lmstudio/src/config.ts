// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as path from "node:path";

export interface LMStudioAgentConfig {
  readonly baseUrl: string;
  readonly apiPath: string;
  readonly model: string;
  readonly apiToken: string;
  readonly workspaceRoot: string;
  readonly maxRounds: number;
  readonly commandTimeoutMs: number;
  readonly maxFileBytes: number;
  readonly maxCommandOutputChars: number;
  readonly maxSearchResults: number;
  readonly enableWebSearch: boolean;
  readonly allowCommandExecution: boolean;
  readonly shell: string;
}

export interface LMStudioAgentConfigOverrides {
  readonly baseUrl?: string;
  readonly apiPath?: string;
  readonly model?: string;
  readonly apiToken?: string;
  readonly workspaceRoot?: string;
  readonly maxRounds?: number;
  readonly commandTimeoutMs?: number;
  readonly maxFileBytes?: number;
  readonly maxCommandOutputChars?: number;
  readonly maxSearchResults?: number;
  readonly enableWebSearch?: boolean;
  readonly allowCommandExecution?: boolean;
  readonly shell?: string;
}

export const LMSTUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234";
export const LMSTUDIO_DEFAULT_API_PATH = "/v1/chat/completions";
export const LMSTUDIO_DEFAULT_MODEL = "mistralai/devstral-small-2-2512";

export function loadConfig(overrides: LMStudioAgentConfigOverrides = {}): LMStudioAgentConfig {
  const workspaceRoot = path.resolve(
    overrides.workspaceRoot ?? process.env.AGENT_WORKSPACE_ROOT ?? process.cwd(),
  );

  return {
    baseUrl: overrides.baseUrl ?? process.env.LMSTUDIO_BASE_URL ?? LMSTUDIO_DEFAULT_BASE_URL,
    apiPath: overrides.apiPath ?? process.env.LMSTUDIO_API_PATH ?? LMSTUDIO_DEFAULT_API_PATH,
    model: overrides.model ?? process.env.LMSTUDIO_MODEL ?? LMSTUDIO_DEFAULT_MODEL,
    apiToken: overrides.apiToken ?? process.env.LMSTUDIO_API_TOKEN ?? "",
    workspaceRoot,
    maxRounds: parseInteger(overrides.maxRounds ?? process.env.AGENT_MAX_ROUNDS, 12),
    commandTimeoutMs: parseInteger(
      overrides.commandTimeoutMs ?? process.env.AGENT_COMMAND_TIMEOUT_MS,
      20_000,
    ),
    maxFileBytes: parseInteger(overrides.maxFileBytes ?? process.env.AGENT_MAX_FILE_BYTES, 200_000),
    maxCommandOutputChars: parseInteger(
      overrides.maxCommandOutputChars ?? process.env.AGENT_MAX_COMMAND_OUTPUT_CHARS,
      12_000,
    ),
    maxSearchResults: parseInteger(
      overrides.maxSearchResults ?? process.env.AGENT_MAX_SEARCH_RESULTS,
      50,
    ),
    enableWebSearch: parseBoolean(
      overrides.enableWebSearch ?? process.env.AGENT_ENABLE_WEB_SEARCH,
      false,
    ),
    allowCommandExecution: parseBoolean(
      overrides.allowCommandExecution ?? process.env.AGENT_ALLOW_COMMAND_EXECUTION,
      true,
    ),
    shell: overrides.shell ?? process.env.AGENT_SHELL ?? "/bin/zsh",
  };
}

export function validateConfig(config: LMStudioAgentConfig): void {
  if (!fs.existsSync(config.workspaceRoot)) {
    throw new Error(
      `Workspace root does not exist: ${config.workspaceRoot}\nSet the workspace root to a valid absolute path before starting the agent.`,
    );
  }
  if (!fs.statSync(config.workspaceRoot).isDirectory()) {
    throw new Error(`Workspace root is not a directory: ${config.workspaceRoot}`);
  }
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
