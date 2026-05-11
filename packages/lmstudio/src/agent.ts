import type { LMStudioAgentConfig } from "./config.ts";
import { createChatCompletion } from "./lmstudioClient.ts";
import type { LMStudioMessage, LMStudioToolCall, ToolRegistry } from "./types.ts";

export interface AgentLogger {
  readonly log: (message: string) => void;
}

export interface LocalCodingAgentInput {
  readonly config: LMStudioAgentConfig;
  readonly registry: ToolRegistry;
  readonly logger?: AgentLogger;
}

export class AgentMaxRoundsError extends Error {
  override readonly name = "AgentMaxRoundsError";
  readonly maxRounds: number;
  constructor(maxRounds: number) {
    super(`Agent exceeded max rounds (${maxRounds}).`);
    this.maxRounds = maxRounds;
  }
}

export class LocalCodingAgent {
  private readonly config: LMStudioAgentConfig;
  private readonly registry: ToolRegistry;
  private readonly logger: AgentLogger;
  private readonly activeToolTags = new Set<string>(["core"]);
  private readonly messages: LMStudioMessage[];

  constructor(input: LocalCodingAgentInput) {
    this.config = input.config;
    this.registry = input.registry;
    this.logger = input.logger ?? { log: () => {} };
    this.messages = [
      { role: "system", content: buildSystemPrompt(this.config, this.activeToolTags) },
    ];
  }

  async run(userInput: string): Promise<string> {
    const guard = buildWorkspaceGuardMessage(this.config.workspaceRoot, userInput);
    if (guard) return guard;

    this.messages.push({ role: "user", content: userInput });

    for (let round = 1; round <= this.config.maxRounds; round += 1) {
      const toolSelection = this.registry.getToolDefinitions({
        userInput,
        activeTags: Array.from(this.activeToolTags),
      });
      this.messages[0] = {
        role: "system",
        content: buildSystemPrompt(this.config, new Set(toolSelection.tags)),
      };

      this.logger.log(`\n[round ${round}] asking ${this.config.model}`);

      const assistantMessage = await createChatCompletion({
        baseUrl: this.config.baseUrl,
        apiPath: this.config.apiPath,
        apiToken: this.config.apiToken,
        model: this.config.model,
        messages: this.messages,
        tools: toolSelection.definitions,
      });

      if (assistantMessage.tool_calls?.length) {
        this.messages.push({
          role: "assistant",
          content: assistantMessage.content || "",
          tool_calls: assistantMessage.tool_calls,
        });

        for (const toolCall of assistantMessage.tool_calls) {
          await this.executeToolCall(toolCall, round);
        }
        continue;
      }

      const finalText = assistantMessage.content || "";
      this.messages.push({ role: "assistant", content: finalText });
      return finalText;
    }

    throw new AgentMaxRoundsError(this.config.maxRounds);
  }

  private async executeToolCall(toolCall: LMStudioToolCall, round: number): Promise<void> {
    const name = toolCall.function.name;
    const args = safeJsonParse(toolCall.function.arguments);
    this.logger.log(`[tool] ${name} ${JSON.stringify(args)}`);

    let result: unknown;
    try {
      const warning = this.getRepeatedToolWarning(name, args, round);
      if (warning) {
        result = warning;
      } else {
        result = await this.registry.execute(name, args);
      }
    } catch (error) {
      result = { error: error instanceof Error ? error.message : String(error) };
    }

    this.logger.log(`[tool-result] ${name}\n${JSON.stringify(result, null, 2)}`);

    const toolMeta = this.registry.getToolByName(name);
    if (toolMeta) {
      for (const tag of toolMeta.tags) {
        this.activeToolTags.add(tag);
      }
    }

    this.messages.push({
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify(result),
    });
  }

  private getRepeatedToolWarning(name: string, args: unknown, round: number): unknown | null {
    const key = `${name}:${stableStringify(args)}`;
    const recentToolCalls = this.messages
      .filter((m): m is LMStudioMessage & { tool_calls: ReadonlyArray<LMStudioToolCall> } =>
        m.role === "assistant" && Array.isArray(m.tool_calls),
      )
      .flatMap((m) =>
        m.tool_calls.map((tc) => ({
          name: tc.function.name,
          args: safeJsonParse(tc.function.arguments),
        })),
      );

    const repeatedCount = recentToolCalls
      .slice(-4)
      .filter((call) => `${call.name}:${stableStringify(call.args)}` === key).length;

    if (repeatedCount < 3) return null;

    return {
      error:
        `Repeated identical tool call detected for ${name} with the same arguments on recent rounds.` +
        " You are stuck. Do not call the same tool again unless the arguments change.",
      round,
    };
  }
}

function buildSystemPrompt(config: LMStudioAgentConfig, tags: Set<string>): string {
  const lines = [
    "You are a local-first coding agent running against LM Studio.",
    `Your workspace root is: ${config.workspaceRoot}`,
    "All tool path arguments must be relative to the workspace root. Never use absolute paths in tool arguments.",
    "Prefer workspace tools before guessing.",
    "When asked to analyze a repository or codebase, use workspace_overview first, then inspect specific files with read_file or search_files.",
    "Use read_file, list_files, and search_files to inspect code before editing.",
    "Use make_directory when the user asks for a new folder or project.",
    "Use write_file or replace_in_file for code changes.",
    "Use run_command for short-lived commands such as tests, builds, formatting, git inspection, and package installs.",
    "If a tool reports a workspace configuration error, stop and explain the misconfiguration instead of retrying the same failing action.",
    "If you repeat the same tool call several times, you are stuck and must change strategy.",
    "Do not reference tools that are unavailable.",
    "Be explicit about what you changed and why.",
  ];

  if (tags.has("web") && config.enableWebSearch) {
    lines.push(
      "web_search and fetch_url are available, but only use them when the user asks for internet-backed help.",
    );
  } else {
    lines.push("No internet-backed tools are available in this run. Stay fully offline.");
  }

  return lines.join("\n");
}

function safeJsonParse(value: string | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  return `{${sortedKeys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

function buildWorkspaceGuardMessage(workspaceRoot: string, userInput: string): string {
  const matches = String(userInput || "").match(/\/[^\s"'`]+/g) ?? [];
  for (const rawPath of matches) {
    if (!rawPath.startsWith("/")) continue;
    if (rawPath === workspaceRoot || rawPath.startsWith(`${workspaceRoot}/`)) continue;
    return [
      `The path \`${rawPath}\` is outside the current workspace root \`${workspaceRoot}\`.`,
      "Switch the runtime workspace first, then retry the request.",
    ].join("\n");
  }
  return "";
}
