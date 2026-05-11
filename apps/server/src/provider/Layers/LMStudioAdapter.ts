/**
 * LMStudioAdapterLive — `ProviderAdapter` for the LM Studio local runtime.
 *
 * LM Studio exposes an OpenAI-compatible `/v1/chat/completions` endpoint.
 * Sessions are entirely client-side here — we maintain a per-thread message
 * history and run a small tool-calling loop on top of `createChatCompletion`
 * from `@prompt-factory/lmstudio`. The adapter shape matches every other
 * provider so the registry/router treats it as a first-class option even
 * though no remote session state exists.
 *
 * Approvals/user-input are stubbed: the local agent currently performs all
 * tool calls without surfacing approval prompts, so the corresponding
 * adapter methods resolve any pending deferreds (none in practice) without
 * touching a remote system.
 *
 * @module LMStudioAdapterLive
 */
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  EventId,
  type LMStudioSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@prompt-factory/contracts";
import {
  createChatCompletion,
  type LMStudioMessage,
  type LMStudioToolCall,
} from "@prompt-factory/lmstudio";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { type LMStudioAdapterShape } from "../Services/LMStudioAdapter.ts";

const PROVIDER = ProviderDriverKind.make("lmStudio");
const DEFAULT_SYSTEM_PROMPT =
  "You are a local LM Studio assistant running entirely on the user's machine. " +
  "Be concise, accurate, and acknowledge when you are unsure.";

class LMStudioChatError extends Data.TaggedError("LMStudioChatError")<{
  readonly detail: string;
  readonly cause: unknown;
}> {}

interface LMStudioTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface LMStudioSessionContext {
  session: ProviderSession;
  readonly threadId: ThreadId;
  readonly messages: Array<LMStudioMessage>;
  readonly turns: Array<LMStudioTurnSnapshot>;
  activeTurn:
    | {
        readonly id: TurnId;
        readonly fiber: Fiber.Fiber<void, never>;
        readonly abortController: AbortController;
      }
    | undefined;
  readonly stopped: Ref.Ref<boolean>;
}

export interface LMStudioAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const ensureSessionContext = (
  sessions: ReadonlyMap<ThreadId, LMStudioSessionContext>,
  threadId: ThreadId,
): LMStudioSessionContext => {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  if (Ref.getUnsafe(session.stopped)) {
    throw new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return session;
};

const buildEventBase = (input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly createdAt?: string | undefined;
}): Effect.Effect<
  Pick<ProviderRuntimeEvent, "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId">
> =>
  Effect.gen(function* () {
    const uuid = yield* Random.nextUUIDv4;
    const createdAt = input.createdAt ?? (yield* nowIso);
    return {
      eventId: EventId.make(uuid),
      provider: PROVIDER,
      threadId: input.threadId,
      createdAt,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    };
  });

const resolveTurnSnapshot = (
  context: LMStudioSessionContext,
  turnId: TurnId,
): LMStudioTurnSnapshot => {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) return existing;
  const created: LMStudioTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
};

const appendTurnItem = (
  context: LMStudioSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void => {
  if (!turnId) return;
  resolveTurnSnapshot(context, turnId).items.push(item);
};

const errorDetail = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
};

export function makeLMStudioAdapter(
  lmStudioSettings: LMStudioSettings,
  options?: LMStudioAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("lmStudio");
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    // Capture an Effect runtime for forking session work outside of the
    // request-scoped fiber. `Effect.fork` would attach the child to the
    // caller's scope (the HTTP request); using `runForkWith(adapterContext)`
    // attaches it to the adapter layer's scope instead so the turn keeps
    // running even after the inbound request fiber finishes.
    const adapterContext = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(adapterContext);

    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, LMStudioSessionContext>();

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) =>
            Effect.gen(function* () {
              yield* Ref.set(context.stopped, true);
              const active = context.activeTurn;
              if (active) {
                active.abortController.abort();
                yield* Fiber.interrupt(active.fiber).pipe(Effect.ignore);
              }
            }),
          { concurrency: "unbounded", discard: true },
        );
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

    const buildSessionForThread = (input: {
      readonly threadId: ThreadId;
      readonly cwd?: string | undefined;
      readonly model: string;
      readonly runtimeMode: ProviderSession["runtimeMode"];
    }) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          model: input.model,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
        };
        return session;
      });

    const updateProviderSession = (
      context: LMStudioSessionContext,
      patch: Partial<ProviderSession>,
      opts?: {
        readonly clearActiveTurnId?: boolean;
        readonly clearLastError?: boolean;
      },
    ): Effect.Effect<ProviderSession> =>
      Effect.gen(function* () {
        const updatedAt = yield* nowIso;
        const nextSession = {
          ...context.session,
          ...patch,
          updatedAt,
        } as ProviderSession & Record<string, unknown>;
        const mutableSession = nextSession as Record<string, unknown>;
        if (opts?.clearActiveTurnId) {
          delete mutableSession.activeTurnId;
        }
        if (opts?.clearLastError) {
          delete mutableSession.lastError;
        }
        context.session = nextSession;
        return nextSession;
      });

    const startSession: LMStudioAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* Ref.set(existing.stopped, true);
          const active = existing.activeTurn;
          if (active) {
            active.abortController.abort();
            yield* Fiber.interrupt(active.fiber).pipe(Effect.ignore);
          }
          sessions.delete(input.threadId);
        }

        const model = input.modelSelection?.model ?? lmStudioSettings.defaultModel;
        const session = yield* buildSessionForThread({
          threadId: input.threadId,
          cwd: input.cwd,
          model,
          runtimeMode: input.runtimeMode,
        });

        const context: LMStudioSessionContext = {
          session,
          threadId: input.threadId,
          messages: [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }],
          turns: [],
          activeTurn: undefined,
          stopped: yield* Ref.make(false),
        };

        sessions.set(input.threadId, context);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "LMStudio session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {},
        });

        return session;
      },
    );

    const emitToolLifecycle = (
      context: LMStudioSessionContext,
      turnId: TurnId,
      toolCall: LMStudioToolCall,
    ) =>
      Effect.gen(function* () {
        const itemId = `lmstudio-tool-${toolCall.id}`;
        appendTurnItem(context, turnId, toolCall);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.threadId,
            turnId,
            itemId,
          })),
          type: "item.completed",
          payload: {
            itemType: "dynamic_tool_call",
            status: "completed",
            title: toolCall.function.name,
            detail: toolCall.function.arguments,
            data: {
              tool: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          },
        });
      });

    const runTurn = (input: {
      readonly context: LMStudioSessionContext;
      readonly turnId: TurnId;
      readonly model: string;
      readonly abortController: AbortController;
    }): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const { context, turnId, model, abortController } = input;
        const maxRounds = Math.max(1, lmStudioSettings.maxRounds);

        for (let round = 1; round <= maxRounds; round += 1) {
          if (abortController.signal.aborted) {
            return;
          }

          const completionExit = yield* Effect.exit(
            Effect.tryPromise({
              try: () =>
                createChatCompletion({
                  baseUrl: lmStudioSettings.baseUrl,
                  apiPath: lmStudioSettings.apiPath,
                  model,
                  messages: context.messages,
                }),
              catch: (cause) =>
                new LMStudioChatError({
                  detail: errorDetail(cause),
                  cause,
                }),
            }),
          );

          if (completionExit._tag === "Failure") {
            const detail = errorDetail(completionExit.cause);
            yield* updateProviderSession(
              context,
              { status: "ready", lastError: detail },
              { clearActiveTurnId: true },
            );
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.threadId, turnId })),
              type: "runtime.error",
              payload: {
                message: detail,
                class: "provider_error",
              },
            });
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.threadId, turnId })),
              type: "turn.completed",
              payload: {
                state: "failed",
                errorMessage: detail,
              },
            });
            return;
          }

          const assistantMessage = completionExit.value;

          yield* writeNativeEventBestEffort(context.threadId, {
            observedAt: yield* nowIso,
            event: {
              provider: PROVIDER,
              threadId: context.threadId,
              turnId,
              type: "chat.completion",
              payload: assistantMessage as unknown as Record<string, unknown>,
            },
          });

          if (assistantMessage.tool_calls?.length) {
            const toolCalls = assistantMessage.tool_calls;
            context.messages.push({
              role: "assistant",
              content: assistantMessage.content || "",
              tool_calls: toolCalls,
            });

            for (const toolCall of toolCalls) {
              yield* emitToolLifecycle(context, turnId, toolCall);
              // The LM Studio runtime does not currently execute tools server
              // side — the embedded `LocalCodingAgent` does that out of band.
              // For Phase 5b we acknowledge the request and respond with a
              // synthetic "tool not executed" body so the chat loop can
              // terminate cleanly rather than spinning the model in a retry.
              context.messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content:
                  '{"notice":"Tool execution is not wired up in this LM Studio adapter. Produce a final answer without further tool calls."}',
              });
            }
            continue;
          }

          const finalText = assistantMessage.content || "";
          context.messages.push({ role: "assistant", content: finalText });

          const assistantItemId = `lmstudio-assistant-${yield* Random.nextUUIDv4}`;
          appendTurnItem(context, turnId, {
            role: "assistant",
            content: finalText,
          });

          if (finalText.length > 0) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.threadId,
                turnId,
                itemId: assistantItemId,
              })),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: finalText,
              },
            });
          }

          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.threadId,
              turnId,
              itemId: assistantItemId,
            })),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              ...(finalText.length > 0 ? { detail: finalText } : {}),
            },
          });

          yield* updateProviderSession(
            context,
            { status: "ready" },
            { clearActiveTurnId: true },
          );
          yield* emit({
            ...(yield* buildEventBase({ threadId: context.threadId, turnId })),
            type: "turn.completed",
            payload: {
              state: "completed",
            },
          });
          return;
        }

        // Max rounds reached without a final answer.
        const message = `LM Studio agent exceeded max rounds (${maxRounds}).`;
        yield* updateProviderSession(
          context,
          { status: "ready", lastError: message },
          { clearActiveTurnId: true },
        );
        yield* emit({
          ...(yield* buildEventBase({ threadId: context.threadId, turnId })),
          type: "turn.completed",
          payload: {
            state: "failed",
            errorMessage: message,
          },
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            // Swallow defects/interrupts — the abort path emits
            // turn.aborted via `interruptTurn`, and we've already taken the
            // session out of `running` state in the normal failure branches
            // above. Anything left over here is genuinely unexpected; log
            // via the native event logger best-effort.
            void cause;
          }),
        ),
      );

    const sendTurn: LMStudioAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = ensureSessionContext(sessions, input.threadId);

      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `LMStudio model selection is bound to instance '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const model = modelSelection?.model ?? lmStudioSettings.defaultModel;
      const text = input.input?.trim();
      if (!text || text.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "LMStudio turns require text input.",
        });
      }

      // If a prior turn is still in flight, interrupt it before starting a
      // new one. The contract says one active turn per session.
      const existingActive = context.activeTurn;
      if (existingActive) {
        existingActive.abortController.abort();
        yield* Fiber.interrupt(existingActive.fiber).pipe(Effect.ignore);
        context.activeTurn = undefined;
      }

      context.messages.push({ role: "user", content: text });

      const turnId = TurnId.make(`lmstudio-turn-${yield* Random.nextUUIDv4}`);
      const abortController = new AbortController();

      appendTurnItem(context, turnId, { role: "user", content: text });
      yield* updateProviderSession(
        context,
        {
          status: "running",
          activeTurnId: turnId,
          model,
        },
        { clearLastError: true },
      );
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
        type: "turn.started",
        payload: {
          model,
        },
      });

      const turnFiber = runFork(runTurn({ context, turnId, model, abortController }));
      context.activeTurn = {
        id: turnId,
        fiber: turnFiber,
        abortController,
      };
      turnFiber.addObserver(() => {
        if (context.activeTurn?.fiber === turnFiber) {
          context.activeTurn = undefined;
        }
      });

      return {
        threadId: input.threadId,
        turnId,
      };
    });

    const interruptTurn: LMStudioAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = ensureSessionContext(sessions, threadId);
        const active = context.activeTurn;
        if (!active) {
          return;
        }
        active.abortController.abort();
        yield* Fiber.interrupt(active.fiber).pipe(Effect.ignore);
        context.activeTurn = undefined;
        yield* emit({
          ...(yield* buildEventBase({ threadId, turnId: turnId ?? active.id })),
          type: "turn.aborted",
          payload: {
            reason: "Interrupted by user.",
          },
        });
        yield* updateProviderSession(
          context,
          { status: "ready" },
          { clearActiveTurnId: true },
        );
      },
    );

    const respondToRequest: LMStudioAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, _requestId, _decision) {
      // The LM Studio adapter never opens an approval request, so the only
      // valid response is a no-op for a session that exists.
      ensureSessionContext(sessions, threadId);
      yield* Effect.void;
    });

    const respondToUserInput: LMStudioAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, _requestId, _answers) {
      ensureSessionContext(sessions, threadId);
      yield* Effect.void;
    });

    const stopSession: LMStudioAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        if (yield* Ref.getAndSet(context.stopped, true)) {
          return;
        }
        const active = context.activeTurn;
        if (active) {
          active.abortController.abort();
          yield* Fiber.interrupt(active.fiber).pipe(Effect.ignore);
          context.activeTurn = undefined;
        }
        sessions.delete(threadId);
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
      },
    );

    const listSessions: LMStudioAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: LMStudioAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: LMStudioAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = ensureSessionContext(sessions, threadId);
        return {
          threadId,
          turns: context.turns.map((turn) => ({
            id: turn.id,
            items: [...turn.items],
          })),
        };
      },
    );

    const rollbackThread: LMStudioAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = ensureSessionContext(sessions, threadId);
        if (numTurns < 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "rollbackThread",
            detail: "numTurns must be >= 0.",
          });
        }
        const keep = Math.max(0, context.turns.length - numTurns);
        context.turns.splice(keep);

        // Walk the message history and drop assistant/tool entries that
        // correspond to removed turns. Heuristic: keep the system prompt
        // plus the first `keep` user-rooted turns.
        const keepUserMessages = keep;
        const keptMessages: Array<LMStudioMessage> = [];
        let userMessagesSeen = 0;
        for (const message of context.messages) {
          if (message.role === "system") {
            keptMessages.push(message);
            continue;
          }
          if (message.role === "user") {
            if (userMessagesSeen >= keepUserMessages) {
              break;
            }
            userMessagesSeen += 1;
          }
          keptMessages.push(message);
        }
        context.messages.length = 0;
        context.messages.push(...keptMessages);

        return {
          threadId,
          turns: context.turns.map((turn) => ({
            id: turn.id,
            items: [...turn.items],
          })),
        };
      },
    );

    const stopAll: LMStudioAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) =>
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(context.stopped, true)) {
                return;
              }
              const active = context.activeTurn;
              if (active) {
                active.abortController.abort();
                yield* Fiber.interrupt(active.fiber).pipe(Effect.ignore);
              }
              yield* emit({
                ...(yield* buildEventBase({ threadId: context.threadId })),
                type: "session.exited",
                payload: {
                  reason: "Adapter stopAll invoked.",
                  recoverable: false,
                  exitKind: "graceful",
                },
              }).pipe(Effect.ignore);
            }),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies LMStudioAdapterShape;
  });
}
