import { describe, expect, it } from "vitest";

import { LocalCodingAgent } from "./agent.ts";
import { LMSTUDIO_DEFAULT_BASE_URL, LMSTUDIO_DEFAULT_MODEL } from "./config.ts";
import type { ToolRegistry } from "./types.ts";

function makeStubRegistry(): ToolRegistry {
  return {
    tools: [],
    openAiTools: [],
    getToolByName: () => null,
    getToolDefinitions: () => ({ tags: ["core"], tools: [], definitions: [] }),
    execute: async () => ({}),
  };
}

describe("LocalCodingAgent", () => {
  it("constructs without invoking the network", () => {
    const agent = new LocalCodingAgent({
      config: {
        baseUrl: LMSTUDIO_DEFAULT_BASE_URL,
        apiPath: "/v1/chat/completions",
        model: LMSTUDIO_DEFAULT_MODEL,
        apiToken: "",
        workspaceRoot: process.cwd(),
        maxRounds: 4,
        commandTimeoutMs: 1000,
        maxFileBytes: 1000,
        maxCommandOutputChars: 1000,
        maxSearchResults: 5,
        enableWebSearch: false,
        allowCommandExecution: false,
        shell: "/bin/zsh",
      },
      registry: makeStubRegistry(),
    });
    expect(agent).toBeInstanceOf(LocalCodingAgent);
  });
});
