import type { ServerAuthDescriptor } from "@prompt-factory/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ServerAuthPolicyShape {
  readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
}

export class ServerAuthPolicy extends Context.Service<ServerAuthPolicy, ServerAuthPolicyShape>()(
  "prompt-factory/auth/Services/ServerAuthPolicy",
) {}
