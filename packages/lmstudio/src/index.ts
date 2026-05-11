export {
  createChatCompletion,
  isLMStudioReachable,
  listLoadedModels,
  LMStudioRequestError,
  LMStudioResponseShapeError,
} from "./lmstudioClient.ts";
export {
  loadConfig,
  validateConfig,
  LMSTUDIO_DEFAULT_BASE_URL,
  LMSTUDIO_DEFAULT_API_PATH,
  LMSTUDIO_DEFAULT_MODEL,
} from "./config.ts";
export type { LMStudioAgentConfig, LMStudioAgentConfigOverrides } from "./config.ts";
export { createToolRegistry } from "./tools.ts";
export { LocalCodingAgent, AgentMaxRoundsError } from "./agent.ts";
export type { AgentLogger, LocalCodingAgentInput } from "./agent.ts";
export type {
  AgentTool,
  AgentToolHandler,
  LMStudioChatRequest,
  LMStudioChatResponse,
  LMStudioMessage,
  LMStudioModelInfo,
  LMStudioToolCall,
  LMStudioToolDefinition,
  ToolRegistry,
  ToolSelection,
} from "./types.ts";
