// SPDX-License-Identifier: Apache-2.0

export interface DaemonProcessRuntime {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stderr: { write(message: string): unknown };
  exit(code: number): unknown;
}

interface RollbackSuggestion {
  readonly hint: string;
  readonly diff?: string | null;
}

export interface DaemonEntrypointDeps {
  readonly defaultConfigPaths: string[];
  readonly exists: (path: string) => boolean;
  readonly parseConfigPaths: (raw: string | undefined) => string[];
  readonly handleRestoreFlag: (
    paths: string[],
    exit: (code: number) => void,
  ) => unknown;
  readonly buildRollbackSuggestion: (
    path: string,
  ) => RollbackSuggestion | null | undefined;
  readonly main: () => Promise<unknown>;
}

export function isDirectDaemonRun(runtime: DaemonProcessRuntime): boolean {
  const executable = runtime.argv[1];
  return executable !== undefined
    && (executable.endsWith("daemon.js")
      || executable.endsWith("daemon.ts")
      || runtime.env["pm_id"] !== undefined);
}

export async function runDaemonEntrypoint(
  runtime: DaemonProcessRuntime,
  deps: DaemonEntrypointDeps,
): Promise<void> {
  const configured = deps.parseConfigPaths(runtime.env["COMIS_CONFIG_PATHS"]);
  const paths = (configured.length > 0
    ? configured
    : deps.defaultConfigPaths).filter(deps.exists);

  if (runtime.argv.includes("--restore-last-good")) {
    deps.handleRestoreFlag(paths, (code) => {
      runtime.exit(code);
    });
    return;
  }

  try {
    await deps.main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    runtime.stderr.write(`FATAL: ${message}\n`);
    const lastPath = paths.at(-1);
    const suggestion = lastPath === undefined
      ? undefined
      : deps.buildRollbackSuggestion(lastPath);
    if (suggestion != null) {
      runtime.stderr.write("\n--- Last-known-good config available ---\n");
      runtime.stderr.write(`${suggestion.hint}\n`);
      if (suggestion.diff != null) {
        runtime.stderr.write(
          `\nChanges since last successful startup:\n${suggestion.diff}\n`,
        );
      }
    }
    runtime.exit(1);
  }
}
