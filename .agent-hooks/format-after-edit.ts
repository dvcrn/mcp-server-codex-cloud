import { extname, isAbsolute, relative, resolve, sep } from "node:path";

interface HookInput {
  cwd?: string;
  tool_input?: {
    command?: string;
    file_path?: string;
    path?: string;
  };
}

const FORMATTED_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".gql",
  ".graphql",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const input = JSON.parse(await Bun.stdin.text()) as HookInput;
const root = await repositoryRoot(input.cwd ?? process.cwd());
const candidates = new Set<string>();

addCandidate(input.tool_input?.file_path ?? input.tool_input?.path);

for (const match of input.tool_input?.command?.matchAll(
  /^\*\*\* (?:(?:Add|Update) File|Move to): (.+)$/gm,
) ?? []) {
  addCandidate(match[1]);
}

const files = Array.from(candidates).filter(
  (path) => FORMATTED_EXTENSIONS.has(extname(path)) && Bun.file(path).size > 0,
);

if (files.length > 0) {
  const formatter = Bun.spawn(
    [
      process.execPath,
      "run",
      "biome",
      "format",
      "--write",
      "--no-errors-on-unmatched",
      ...files,
    ],
    {
      cwd: root,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  process.exit(await formatter.exited);
}

/** Adds a formatter target only when it resolves inside the repository. */
function addCandidate(path: string | undefined): void {
  if (!path) {
    return;
  }

  const absolute = resolve(root, path);
  const localPath = relative(root, absolute);
  if (
    localPath === ".."
    || localPath.startsWith(`..${sep}`)
    || isAbsolute(localPath)
  ) {
    return;
  }

  candidates.add(absolute);
}

/** Resolves the active repository root used to constrain formatter inputs. */
async function repositoryRoot(cwd: string): Promise<string> {
  const command = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });

  if ((await command.exited) !== 0) {
    process.exit(0);
  }

  return (await new Response(command.stdout).text()).trim();
}
