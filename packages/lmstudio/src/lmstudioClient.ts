// @effect-diagnostics globalTimers:off
import type {
  LMStudioChatRequest,
  LMStudioChatResponse,
  LMStudioModelInfo,
} from "./types.ts";

export class LMStudioRequestError extends Error {
  override readonly name = "LMStudioRequestError";
  readonly status: number;
  readonly body: string;
  constructor(status: number, statusText: string, body: string) {
    super(`LM Studio request failed: ${status} ${statusText}\n${body}`);
    this.status = status;
    this.body = body;
  }
}

export class LMStudioResponseShapeError extends Error {
  override readonly name = "LMStudioResponseShapeError";
  readonly payload: unknown;
  constructor(payload: unknown) {
    super(`LM Studio response did not contain a message: ${JSON.stringify(payload, null, 2)}`);
    this.payload = payload;
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export async function createChatCompletion(
  request: LMStudioChatRequest,
): Promise<LMStudioChatResponse> {
  const { baseUrl, apiPath, apiToken, model, messages, tools, temperature = 0.2 } = request;

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;

  const response = await fetch(new URL(apiPath, ensureTrailingSlash(baseUrl)).toString(), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      temperature,
      tool_choice: "auto",
      messages,
      tools,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new LMStudioRequestError(response.status, response.statusText, body);
  }

  const data = (await response.json()) as {
    choices?: ReadonlyArray<{ message?: LMStudioChatResponse }>;
  };
  const message = data?.choices?.[0]?.message;
  if (!message) {
    throw new LMStudioResponseShapeError(data);
  }
  return message;
}

export async function listLoadedModels(input: {
  readonly baseUrl: string;
  readonly apiToken?: string;
}): Promise<ReadonlyArray<LMStudioModelInfo>> {
  const url = new URL("v1/models", ensureTrailingSlash(input.baseUrl)).toString();
  const headers: Record<string, string> = {};
  if (input.apiToken) headers.authorization = `Bearer ${input.apiToken}`;
  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    const body = await response.text();
    throw new LMStudioRequestError(response.status, response.statusText, body);
  }
  const payload = (await response.json()) as { data?: ReadonlyArray<LMStudioModelInfo> };
  return payload.data ?? [];
}

export async function isLMStudioReachable(input: {
  readonly baseUrl: string;
  readonly apiToken?: string;
  readonly timeoutMs?: number;
}): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 2_000);
  try {
    const url = new URL("v1/models", ensureTrailingSlash(input.baseUrl)).toString();
    const headers: Record<string, string> = {};
    if (input.apiToken) headers.authorization = `Bearer ${input.apiToken}`;
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
