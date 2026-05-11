// @effect-diagnostics nodeBuiltinImport:off
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import type { LMStudioAgentConfig } from "./config.ts";
import type { AgentTool, ToolRegistry, ToolSelection } from "./types.ts";

const exec = promisify(childProcess.exec);

interface ShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runShell(
  command: string,
  config: LMStudioAgentConfig,
  cwd: string = config.workspaceRoot,
  options: { readonly timeoutMs?: number } = {},
): Promise<ShellResult> {
  try {
    const { stdout, stderr } = await exec(command, {
      cwd,
      shell: config.shell,
      timeout: options.timeoutMs ?? config.commandTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly code?: number | string;
    };
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: [err.stderr, err.message].filter(Boolean).join("\n"),
    };
  }
}

function resolveWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (path.isAbsolute(inputPath)) {
    throw new Error(
      `Absolute paths are not allowed in tool arguments: ${inputPath}. Use a path relative to the workspace root.`,
    );
  }
  const resolved = path.resolve(workspaceRoot, inputPath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace root: ${inputPath}`);
  }
  return resolved;
}

function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath) || ".";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

function countOccurrences(text: string, search: string): number {
  return text.split(search).length - 1;
}

function shellEscape(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

async function walk(root: string, depth: number, currentDepth = 0): Promise<string[]> {
  const stats = await fs.stat(root);
  if (!stats.isDirectory()) return [root];

  const entries = await fs.readdir(root, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if ([".git", "node_modules", ".DS_Store"].includes(entry.name)) continue;
    const absolute = path.join(root, entry.name);
    out.push(absolute);
    if (entry.isDirectory() && currentDepth < depth - 1) {
      out.push(...(await walk(absolute, depth, currentDepth + 1)));
    }
  }
  return out;
}

function defineTool<Args extends Record<string, unknown>>(input: {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly handler: (args: Args) => Promise<unknown>;
  readonly tags?: ReadonlyArray<string>;
}): AgentTool {
  return {
    name: input.name,
    tags: input.tags ?? ["core"],
    handler: (args) => input.handler(args as Args),
    definition: {
      type: "function",
      function: {
        name: input.name,
        description: input.description,
        parameters: input.parameters,
      },
    },
  };
}

function selectToolTags(input: {
  readonly userInput?: string;
  readonly activeTags?: ReadonlyArray<string>;
}): Set<string> {
  return new Set(["core", ...(input.activeTags ?? [])]);
}

export function createToolRegistry(config: LMStudioAgentConfig): ToolRegistry {
  const tools: AgentTool[] = [
    defineTool({
      name: "workspace_overview",
      description:
        "Get a compact overview of the current workspace root, including top-level entries, likely project files, and key manifests.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const topLevelEntries = (await walk(config.workspaceRoot, 1)).map((entry) =>
          toWorkspaceRelative(config.workspaceRoot, entry),
        );
        const likelyProjectFiles = topLevelEntries.filter((entry) =>
          /(^README|package\.json$|tsconfig\.json$|pyproject\.toml$|Cargo\.toml$|go\.mod$|Dockerfile$|Makefile$)/i.test(
            entry,
          ),
        );
        const likelyDirectories = topLevelEntries.filter(
          (entry) => !entry.includes(".") && entry !== ".git",
        );
        return {
          workspace_root: config.workspaceRoot,
          top_level_entries: topLevelEntries.slice(0, 80),
          likely_project_files: likelyProjectFiles.slice(0, 40),
          likely_directories: likelyDirectories.slice(0, 40),
        };
      },
    }),
    defineTool({
      name: "list_files",
      description: "List files and directories under a workspace path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path inside the workspace. Defaults to '.'." },
          depth: { type: "integer", description: "Maximum recursion depth. Defaults to 1." },
        },
      },
      handler: async (args: { path?: string; depth?: number }) => {
        const targetPath = args.path ?? ".";
        const depth = args.depth ?? 1;
        const resolved = resolveWorkspacePath(config.workspaceRoot, targetPath);
        const entries = (await walk(resolved, depth)).map((entry) =>
          toWorkspaceRelative(config.workspaceRoot, entry),
        );
        return {
          workspace_path: toWorkspaceRelative(config.workspaceRoot, resolved),
          entries,
        };
      },
    }),
    defineTool({
      name: "make_directory",
      description: "Create a directory inside the workspace.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Relative directory path." } },
        required: ["path"],
      },
      handler: async (args: { path: string }) => {
        const resolved = resolveWorkspacePath(config.workspaceRoot, args.path);
        await fs.mkdir(resolved, { recursive: true });
        return { path: toWorkspaceRelative(config.workspaceRoot, resolved), created: true };
      },
    }),
    defineTool({
      name: "read_file",
      description: "Read a UTF-8 text file from the workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path inside the workspace." },
          start_line: { type: "integer", description: "1-based line number to start reading from." },
          end_line: { type: "integer", description: "1-based line number to end reading at." },
        },
        required: ["path"],
      },
      handler: async (args: { path: string; start_line?: number; end_line?: number }) => {
        const resolved = resolveWorkspacePath(config.workspaceRoot, args.path);
        const content = await fs.readFile(resolved, "utf8");
        const lines = content.split("\n");
        const start = clamp(args.start_line ?? 1, 1, lines.length);
        const end = clamp(args.end_line ?? 200, start, lines.length);
        const selection = lines.slice(start - 1, end).join("\n");
        return {
          path: toWorkspaceRelative(config.workspaceRoot, resolved),
          start_line: start,
          end_line: end,
          content: limitText(selection, config.maxFileBytes),
        };
      },
    }),
    defineTool({
      name: "write_file",
      description:
        "Write or overwrite a UTF-8 text file in the workspace. Parent directories are created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path inside the workspace." },
          content: { type: "string", description: "Full file contents to write." },
        },
        required: ["path", "content"],
      },
      handler: async (args: { path: string; content: string }) => {
        const resolved = resolveWorkspacePath(config.workspaceRoot, args.path);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, args.content, "utf8");
        return {
          path: toWorkspaceRelative(config.workspaceRoot, resolved),
          bytes_written: Buffer.byteLength(args.content, "utf8"),
        };
      },
    }),
    defineTool({
      name: "replace_in_file",
      description: "Replace text in a UTF-8 text file. Useful for surgical edits.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path inside the workspace." },
          search: { type: "string", description: "Text to search for." },
          replace: { type: "string", description: "Replacement text." },
          replace_all: {
            type: "boolean",
            description: "Replace all matches instead of just the first one.",
          },
        },
        required: ["path", "search", "replace"],
      },
      handler: async (args: {
        path: string;
        search: string;
        replace: string;
        replace_all?: boolean;
      }) => {
        const resolved = resolveWorkspacePath(config.workspaceRoot, args.path);
        const before = await fs.readFile(resolved, "utf8");
        if (!before.includes(args.search)) {
          return {
            path: toWorkspaceRelative(config.workspaceRoot, resolved),
            replaced: 0,
            message: "Search text not found.",
          };
        }
        const replaceAll = args.replace_all ?? false;
        const after = replaceAll
          ? before.split(args.search).join(args.replace)
          : before.replace(args.search, args.replace);
        await fs.writeFile(resolved, after, "utf8");
        return {
          path: toWorkspaceRelative(config.workspaceRoot, resolved),
          replaced: replaceAll ? countOccurrences(before, args.search) : 1,
        };
      },
    }),
    defineTool({
      name: "search_files",
      description: "Search text in workspace files using ripgrep.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern." },
          path: { type: "string", description: "Relative path. Defaults to '.'." },
        },
        required: ["pattern"],
      },
      handler: async (args: { pattern: string; path?: string }) => {
        const resolved = resolveWorkspacePath(config.workspaceRoot, args.path ?? ".");
        const command = `rg --line-number --color never --smart-case ${shellEscape(args.pattern)} ${shellEscape(resolved)}`;
        const result = await runShell(command, config);
        return {
          path: toWorkspaceRelative(config.workspaceRoot, resolved),
          matches: limitText(result.stdout || result.stderr || "", config.maxCommandOutputChars),
        };
      },
    }),
    defineTool({
      name: "run_command",
      description:
        "Run a short-lived shell command inside the workspace. Use for builds, tests, git, and package installs.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute." },
          cwd: { type: "string", description: "Relative working directory. Defaults to '.'." },
        },
        required: ["command"],
      },
      handler: async (args: { command: string; cwd?: string }) => {
        if (!config.allowCommandExecution) {
          return { error: "Command execution is disabled by configuration." };
        }
        const resolved = resolveWorkspacePath(config.workspaceRoot, args.cwd ?? ".");
        const result = await runShell(args.command, config, resolved);
        return {
          cwd: toWorkspaceRelative(config.workspaceRoot, resolved),
          exit_code: result.exitCode,
          stdout: limitText(result.stdout, config.maxCommandOutputChars),
          stderr: limitText(result.stderr, config.maxCommandOutputChars),
        };
      },
    }),
    defineTool({
      name: "git_status",
      description: "Return git status for the current workspace.",
      parameters: { type: "object", properties: {} },
      handler: async () => {
        const result = await runShell("git status --short --branch", config, config.workspaceRoot);
        return {
          status: limitText(result.stdout || result.stderr || "", config.maxCommandOutputChars),
        };
      },
    }),
  ];

  return {
    tools,
    openAiTools: tools.map((tool) => tool.definition),
    getToolByName(name): AgentTool | null {
      return tools.find((item) => item.name === name) ?? null;
    },
    getToolDefinitions(input): ToolSelection {
      const tags = selectToolTags(input ?? {});
      const selected = tools.filter((tool) => tool.tags.some((tag) => tags.has(tag)));
      return {
        tags: Array.from(tags),
        tools: selected,
        definitions: selected.map((tool) => tool.definition),
      };
    },
    async execute(name, args): Promise<unknown> {
      const tool = tools.find((item) => item.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return tool.handler((args ?? {}) as Record<string, unknown>);
    },
  };
}
