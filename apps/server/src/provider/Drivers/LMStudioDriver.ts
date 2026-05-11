/**
 * LMStudioDriver — `ProviderDriver` for the LM Studio local runtime.
 *
 * LM Studio runs entirely on the user's machine through an
 * OpenAI-compatible chat completions endpoint. There is no per-instance
 * child process to manage — the driver just decodes its config, builds the
 * adapter + text generation closures over that config, and hands the
 * registry a snapshot probe that pings the server periodically.
 *
 * The driver is single-instance for now (`supportsMultipleInstances: false`)
 * to keep settings UX simple. Multiple instances would require per-instance
 * model defaults and a separate adapter per base URL, which we can add
 * later if users want to talk to several LM Studio servers at once.
 *
 * @module provider/Drivers/LMStudioDriver
 */
import {
  LMStudioSettings,
  ProviderDriverKind,
  type ServerProvider,
} from "@prompt-factory/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeLMStudioTextGeneration } from "../../textGeneration/LMStudioTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeLMStudioAdapter } from "../Layers/LMStudioAdapter.ts";
import {
  checkLMStudioProviderStatus,
  makePendingLMStudioProvider,
} from "../Layers/LMStudioProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeProviderMaintenanceCapabilities,
  makeStaticProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";

const decodeLMStudioSettings = Schema.decodeSync(LMStudioSettings);

const DRIVER_KIND = ProviderDriverKind.make("lmStudio");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);
const UPDATE = makeStaticProviderMaintenanceResolver(
  makeProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: null,
    updateExecutable: null,
    updateArgs: [],
    updateLockKey: "lmstudio",
  }),
);

export type LMStudioDriverEnv = FileSystem.FileSystem | ProviderEventLoggers;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const LMStudioDriver: ProviderDriver<LMStudioSettings, LMStudioDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "LMStudio",
    supportsMultipleInstances: false,
  },
  configSchema: LMStudioSettings,
  defaultConfig: (): LMStudioSettings => decodeLMStudioSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies LMStudioSettings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        env: processEnv,
      });

      const adapter = yield* makeLMStudioAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeLMStudioTextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkLMStudioProviderStatus(effectiveConfig).pipe(
        Effect.map(stampIdentity),
      );

      const snapshot = yield* makeManagedServerProvider<LMStudioSettings>({
        maintenanceCapabilities,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          makePendingLMStudioProvider(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build LMStudio snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
