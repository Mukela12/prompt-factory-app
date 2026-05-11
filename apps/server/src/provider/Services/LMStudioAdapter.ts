/**
 * LMStudioAdapter — shape type for the LM Studio provider adapter.
 *
 * Mirrors `ClaudeAdapter` / `OpenCodeAdapter` — the driver bundles one
 * adapter per instance as a captured closure, so all we expose here is
 * a naming anchor over the generic adapter shape.
 *
 * @module LMStudioAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * LMStudioAdapterShape — per-instance LM Studio adapter contract.
 */
export interface LMStudioAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
