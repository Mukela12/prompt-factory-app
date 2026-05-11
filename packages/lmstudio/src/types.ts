export interface LMStudioMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: ReadonlyArray<LMStudioToolCall>;
}

export interface LMStudioToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface LMStudioToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface LMStudioChatRequest {
  readonly baseUrl: string;
  readonly apiPath: string;
  readonly apiToken?: string;
  readonly model: string;
  readonly messages: ReadonlyArray<LMStudioMessage>;
  readonly tools?: ReadonlyArray<LMStudioToolDefinition>;
  readonly temperature?: number;
}

export interface LMStudioChatResponse {
  readonly role: "assistant";
  readonly content: string;
  readonly tool_calls?: ReadonlyArray<LMStudioToolCall>;
}

export interface LMStudioModelInfo {
  readonly id: string;
  readonly object: string;
  readonly owned_by?: string;
}

export interface AgentToolHandler {
  (args: Record<string, unknown>): Promise<unknown>;
}

export interface AgentTool {
  readonly name: string;
  readonly tags: ReadonlyArray<string>;
  readonly definition: LMStudioToolDefinition;
  readonly handler: AgentToolHandler;
}

export interface ToolSelection {
  readonly tags: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<AgentTool>;
  readonly definitions: ReadonlyArray<LMStudioToolDefinition>;
}

export interface ToolRegistry {
  readonly tools: ReadonlyArray<AgentTool>;
  readonly openAiTools: ReadonlyArray<LMStudioToolDefinition>;
  readonly getToolByName: (name: string) => AgentTool | null;
  readonly getToolDefinitions: (input?: {
    readonly userInput?: string;
    readonly activeTags?: ReadonlyArray<string>;
  }) => ToolSelection;
  readonly execute: (name: string, args: unknown) => Promise<unknown>;
}
