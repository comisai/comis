// SPDX-License-Identifier: Apache-2.0
import { splitCommandSegments } from "../exec-security/index.js";

export const DESTRUCTIVE_NO_EFFECT_MESSAGE =
  "No filesystem entries were removed; the deletion command had no observable effect.";

function executableName(segment: string): string {
  const token = segment.trim().split(/\s+/, 1)[0] ?? "";
  return token.split("/").at(-1) ?? token;
}

function isStandaloneRemovalCommand(command: string): boolean {
  const segments = splitCommandSegments(command);
  return segments.length === 1 && executableName(segments[0] ?? "") === "rm";
}

export function isDestructiveExecCommand(command: string): boolean {
  return splitCommandSegments(command).some((segment) => {
    const words = segment.trim().split(/\s+/);
    const executable = executableName(segment);
    if (["rm", "rmdir", "shred", "truncate", "kill", "pkill", "killall"].includes(executable)) {
      return true;
    }
    if (executable === "find" && words.includes("-delete")) {
      return true;
    }
    if (executable !== "git") {
      return false;
    }
    return (
      (words.includes("reset") && words.includes("--hard"))
      || (
        words.includes("clean")
        && words.some(
          (word) => word === "-f" || word === "--force" || /^-[^-]*f/.test(word),
        )
      )
      || (
        words.includes("push")
        && words.some(
          (word) => word === "-f" || word === "--force" || word === "--force-with-lease",
        )
      )
    );
  });
}

export function instrumentRemovalCommand(command: string): string {
  if (!isStandaloneRemovalCommand(command)) {
    return command;
  }
  const start = command.search(/\S/);
  if (start < 0) {
    return command;
  }
  let end = start;
  while (end < command.length && !/\s/.test(command.charAt(end))) {
    end += 1;
  }
  const args = command.slice(end).trim().split(/\s+/);
  const verbose = args.some(
    (arg) =>
      arg === "--verbose"
      || (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("v")),
  );
  return verbose
    ? command
    : `${command.slice(0, end)} -v${command.slice(end)}`;
}

export function gradeDestructiveExecEffect(params: {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}): {
  exitCode: number;
  stderr: string;
  destructiveEffect?: "verified" | "none";
} {
  if (!isStandaloneRemovalCommand(params.command) || params.exitCode !== 0) {
    return { exitCode: params.exitCode, stderr: params.stderr };
  }
  if (params.stdout.trim().length > 0) {
    return {
      exitCode: params.exitCode,
      stderr: params.stderr,
      destructiveEffect: "verified",
    };
  }
  return {
    exitCode: 3,
    stderr: [params.stderr.trim(), DESTRUCTIVE_NO_EFFECT_MESSAGE].filter(Boolean).join("\n"),
    destructiveEffect: "none",
  };
}
