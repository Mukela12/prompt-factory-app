/**
 * LMStudioTextGeneration — LM Studio backed implementation of
 * `TextGenerationShape`.
 *
 * Drives `createChatCompletion` from `@prompt-factory/lmstudio` with a
 * system prompt that asks the model to emit a JSON object matching the
 * caller's structured-output schema. Decodes the model's response against
 * that schema and returns the canonical commit / PR / branch / thread
 * payload shape.
 *
 * Tools are deliberately disabled here — the local agent has its own
 * tool registry, but commit-message style generation never needs it and
 * tool calls would confuse the structured-output extraction.
 *
 * @module LMStudioTextGeneration
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  TextGenerationError,
  type LMStudioSettings,
  type ModelSelection,
} from "@prompt-factory/contracts";
import { createChatCompletion, type LMStudioMessage } from "@prompt-factory/lmstudio";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@prompt-factory/shared/git";
import { extractJsonObject } from "@prompt-factory/shared/schemaJson";

import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";

type LMStudioTextOperation =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const buildSystemPrompt = (outputSchemaJson: unknown): string =>
  [
    "You are a local LM Studio assistant that produces strictly structured JSON.",
    "Respond with a single JSON object that matches the user's schema exactly.",
    "Do not wrap the JSON in code fences. Do not include commentary. Output JSON only.",
    "JSON schema:",
    JSON.stringify(outputSchemaJson),
  ].join("\n");

const errorDetail = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
};

export const makeLMStudioTextGeneration = Effect.fn("makeLMStudioTextGeneration")(function* (
  lmStudioSettings: LMStudioSettings,
  _environment: NodeJS.ProcessEnv = process.env,
) {
  void _environment;

  const runLMStudioJson = Effect.fn("runLMStudioJson")(function* <S extends Schema.Top>(input: {
    readonly operation: LMStudioTextOperation;
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }) {
    void input.cwd;
    const schemaJson = toJsonSchemaObject(input.outputSchemaJson);
    const messages: ReadonlyArray<LMStudioMessage> = [
      { role: "system", content: buildSystemPrompt(schemaJson) },
      { role: "user", content: input.prompt },
    ];

    const model = input.modelSelection.model || lmStudioSettings.defaultModel;

    const rawText = yield* Effect.tryPromise({
      try: async () => {
        const response = await createChatCompletion({
          baseUrl: lmStudioSettings.baseUrl,
          apiPath: lmStudioSettings.apiPath,
          model,
          messages,
          // No tools — structured-output mode only.
        });
        const content = response.content?.trim() ?? "";
        if (content.length === 0) {
          throw new Error("LM Studio returned an empty response.");
        }
        return content;
      },
      catch: (cause) =>
        new TextGenerationError({
          operation: input.operation,
          detail: errorDetail(cause),
          cause,
        }),
    });

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(rawText)).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation: input.operation,
            detail: "LM Studio returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "LMStudioTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    const generated = yield* runLMStudioJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "LMStudioTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    const generated = yield* runLMStudioJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "LMStudioTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runLMStudioJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "LMStudioTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    const generated = yield* runLMStudioJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});
