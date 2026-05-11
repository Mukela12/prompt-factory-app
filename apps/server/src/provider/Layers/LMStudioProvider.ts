/**
 * LMStudioProvider — snapshot probe for the LM Studio runtime.
 *
 * Reachability check: hit `${baseUrl}/v1/models` (via `isLMStudioReachable`),
 * then `listLoadedModels` to enumerate what the local server is currently
 * exposing. When the user has disabled the provider, we emit a "disabled"
 * shadow snapshot and never touch the network.
 *
 * Errors map to an `unavailable`-style probe so the registry can still
 * surface the instance in the UI with a clear reason.
 *
 * @module provider/Layers/LMStudioProvider
 */
import {
  type LMStudioSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@prompt-factory/contracts";
import {
  isLMStudioReachable,
  listLoadedModels,
} from "@prompt-factory/lmstudio";
import { createModelCapabilities } from "@prompt-factory/shared/model";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("lmStudio");

class LMStudioProbeError extends Data.TaggedError("LMStudioProbeError")<{
  readonly detail: string;
  readonly cause: unknown;
}> {}
const LMSTUDIO_PRESENTATION = {
  displayName: "LMStudio",
  showInteractionModeToggle: false,
} as const;

const DEFAULT_LMSTUDIO_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function modelsFromLoaded(
  loaded: ReadonlyArray<{ readonly id: string }>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const entry of loaded) {
    const slug = entry.id.trim();
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: slug,
      isCustom: false,
      capabilities: DEFAULT_LMSTUDIO_MODEL_CAPABILITIES,
    });
  }
  return models;
}

/**
 * Pending snapshot. Used before the first probe completes. Renders
 * `unavailable` when the user has explicitly disabled the integration, and
 * a `warning` probe otherwise so the UI can show "not checked yet".
 */
export const makePendingLMStudioProvider = (
  lmStudioSettings: LMStudioSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const builtIn: ReadonlyArray<ServerProviderModel> = [
      {
        slug: lmStudioSettings.defaultModel,
        name: lmStudioSettings.defaultModel,
        isCustom: false,
        capabilities: DEFAULT_LMSTUDIO_MODEL_CAPABILITIES,
      },
    ];
    const models = providerModelsFromSettings(
      builtIn,
      PROVIDER,
      [],
      DEFAULT_LMSTUDIO_MODEL_CAPABILITIES,
    );

    if (!lmStudioSettings.enabled) {
      return buildServerProvider({
        presentation: LMSTUDIO_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "LMStudio is disabled in Prompt Factory settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: LMSTUDIO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "LMStudio provider status has not been checked in this session yet.",
      },
    });
  });

/**
 * Run a live probe against the configured base URL. Returns `unavailable`
 * with a useful detail message whenever the server is unreachable; otherwise
 * `ready` and exposes the set of currently loaded models.
 */
export const checkLMStudioProviderStatus = Effect.fn("checkLMStudioProviderStatus")(function* (
  lmStudioSettings: LMStudioSettings,
): Effect.fn.Return<ServerProviderDraft, never, never> {
  const checkedAt = yield* nowIso;
  const fallbackBuiltIn: ReadonlyArray<ServerProviderModel> = [
    {
      slug: lmStudioSettings.defaultModel,
      name: lmStudioSettings.defaultModel,
      isCustom: false,
      capabilities: DEFAULT_LMSTUDIO_MODEL_CAPABILITIES,
    },
  ];

  if (!lmStudioSettings.enabled) {
    return buildServerProvider({
      presentation: LMSTUDIO_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings(
        fallbackBuiltIn,
        PROVIDER,
        [],
        DEFAULT_LMSTUDIO_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "LMStudio is disabled in Prompt Factory settings.",
      },
    });
  }

  const reachableExit = yield* Effect.exit(
    Effect.tryPromise({
      try: () => isLMStudioReachable({ baseUrl: lmStudioSettings.baseUrl }),
      catch: (cause) =>
        new LMStudioProbeError({
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }),
  );
  const reachable = reachableExit._tag === "Success" ? reachableExit.value : false;

  if (!reachable) {
    return buildServerProvider({
      presentation: LMSTUDIO_PRESENTATION,
      enabled: true,
      checkedAt,
      models: providerModelsFromSettings(
        fallbackBuiltIn,
        PROVIDER,
        [],
        DEFAULT_LMSTUDIO_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Couldn't reach LM Studio at ${lmStudioSettings.baseUrl}. Start LM Studio and load a model, then retry.`,
      },
    });
  }

  const loadedExit = yield* Effect.exit(
    Effect.tryPromise({
      try: () => listLoadedModels({ baseUrl: lmStudioSettings.baseUrl }),
      catch: (cause) =>
        new LMStudioProbeError({
          detail: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }),
  );

  if (loadedExit._tag === "Failure") {
    return buildServerProvider({
      presentation: LMSTUDIO_PRESENTATION,
      enabled: true,
      checkedAt,
      models: providerModelsFromSettings(
        fallbackBuiltIn,
        PROVIDER,
        [],
        DEFAULT_LMSTUDIO_MODEL_CAPABILITIES,
      ),
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: `LM Studio reachable at ${lmStudioSettings.baseUrl}, but model listing failed.`,
      },
    });
  }

  const loadedModels = modelsFromLoaded(loadedExit.value);
  const builtIn: ReadonlyArray<ServerProviderModel> =
    loadedModels.length > 0 ? loadedModels : fallbackBuiltIn;

  const models = providerModelsFromSettings(
    builtIn,
    PROVIDER,
    [],
    DEFAULT_LMSTUDIO_MODEL_CAPABILITIES,
  );

  return buildServerProvider({
    presentation: LMSTUDIO_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: loadedModels.length > 0 ? "ready" : "warning",
      auth: {
        status: "authenticated",
        type: "lmstudio",
      },
      message:
        loadedModels.length > 0
          ? `LM Studio reachable at ${lmStudioSettings.baseUrl}. ${loadedModels.length} model${loadedModels.length === 1 ? "" : "s"} loaded.`
          : `LM Studio reachable at ${lmStudioSettings.baseUrl}, but no models are currently loaded.`,
    },
  });
});
