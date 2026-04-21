// SPDX-License-Identifier: Apache-2.0
/**
 * Signal CLI setup helper command.
 *
 * Provides `comis signal-setup` that guides operators through installing
 * signal-cli, checking Java prerequisites, registering a phone number, and
 * verifying the Signal connection. Uses Clack prompts for interactive UX.
 *
 * @module
 */

import type { Command } from "commander";
import * as p from "@clack/prompts";
import { execFileSync } from "node:child_process";

/** Minimum Java version required by signal-cli. */
const MIN_JAVA_VERSION = 21;

/** E.164 phone number format: + followed by 7-15 digits. */
const E164_REGEX = /^\+\d{7,15}$/;

/** 6-digit verification code. */
const VERIFY_CODE_REGEX = /^\d{6}$/;

/**
 * Run a command with array arguments and capture stdout. Returns undefined on failure.
 * Uses execFileSync (no shell) to prevent command injection.
 *
 * @param file - Executable to run
 * @param args - Arguments array (each element is a separate argument, never shell-interpolated)
 * @returns stdout string, or undefined if command failed
 */
function tryExecFile(file: string, args: string[]): string | undefined {
  try {
    return execFileSync(file, args, { encoding: "utf-8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return undefined;
  }
}

/**
 * Run a command with array arguments and capture combined stdout + stderr output.
 * Handles commands like `java -version` that write to stderr even on success.
 * Uses execFileSync (no shell) to prevent command injection.
 *
 * @param file - Executable to run
 * @param args - Arguments array (each element is a separate argument, never shell-interpolated)
 * @returns Combined output string, or undefined if command failed and produced no output
 */
function tryExecFileOutput(file: string, args: string[]): string | undefined {
  try {
    const stdout = execFileSync(file, args, { encoding: "utf-8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] });
    return stdout || undefined;
  } catch (err) {
    // Some commands (java -version) write to stderr even on exit 0 in some JDK builds,
    // or may exit non-zero. Capture stderr from the error object.
    if (err && typeof err === "object") {
      const e = err as { stdout?: string; stderr?: string };
      const output = (e.stdout || "") + (e.stderr || "");
      return output || undefined;
    }
    return undefined;
  }
}

/**
 * Parse Java version from `java -version` output.
 *
 * Handles formats like:
 * - openjdk version "21.0.1" ...
 * - java version "1.8.0_331" ...
 *
 * @param output - Output from java -version (usually stderr)
 * @returns Parsed major version number, or 0 if unparseable
 */
function parseJavaVersion(output: string): number {
  // Try "21.x.x" or "17.x.x" format
  const modernMatch = output.match(/version\s+"(\d+)/);
  if (modernMatch) {
    return parseInt(modernMatch[1], 10);
  }

  // Try legacy "1.8.x" format
  const legacyMatch = output.match(/version\s+"1\.(\d+)/);
  if (legacyMatch) {
    return parseInt(legacyMatch[1], 10);
  }

  return 0;
}

/**
 * Step 1: Check Java installation.
 *
 * @returns true if Java is suitable or user chose to continue anyway
 */
async function checkJava(): Promise<boolean> {
  const spinner = p.spinner();
  spinner.start("Checking Java installation...");

  // java -version writes to stderr on most JDKs; tryExecFileOutput captures both streams
  const output = tryExecFileOutput("java", ["-version"]) ?? "";

  if (!output) {
    spinner.stop("Java not found");
    p.log.error(
      "Signal CLI requires Java 21+.\n" +
      "  Install via:\n" +
      "    Ubuntu/Debian: sudo apt install openjdk-21-jre\n" +
      "    Fedora:        sudo dnf install java-21-openjdk\n" +
      "    macOS:         brew install openjdk@21",
    );

    const proceed = await p.confirm({
      message: "Continue without Java? (signal-cli will not work)",
    });

    return !p.isCancel(proceed) && !!proceed;
  }

  const version = parseJavaVersion(output);

  if (version < MIN_JAVA_VERSION) {
    spinner.stop(`Java ${version} found (${MIN_JAVA_VERSION}+ required)`);
    p.log.warning(
      `Signal CLI requires Java ${MIN_JAVA_VERSION}+. Current: Java ${version}.\n` +
      "  Upgrade via:\n" +
      "    Ubuntu/Debian: sudo apt install openjdk-21-jre\n" +
      "    Fedora:        sudo dnf install java-21-openjdk\n" +
      "    macOS:         brew install openjdk@21",
    );

    const proceed = await p.confirm({
      message: "Continue with incompatible Java version?",
    });

    return !p.isCancel(proceed) && !!proceed;
  }

  spinner.stop(`Java ${version} found`);
  return true;
}

/**
 * Step 2: Check existing signal-cli installation.
 *
 * @returns "configure" if existing install found and user wants to configure only,
 *          "install" if needs installation, "abort" if user cancelled
 */
async function checkSignalCli(): Promise<"configure" | "install" | "abort"> {
  const output = tryExecFile("signal-cli", ["--version"]);

  if (output) {
    const version = output.trim();
    p.log.info(`signal-cli already installed: ${version}`);

    const action = await p.select({
      message: "What would you like to do?",
      options: [
        { value: "configure", label: "Configure only (skip installation)" },
        { value: "install", label: "Reinstall signal-cli" },
      ],
    });

    if (p.isCancel(action)) return "abort";
    return action as "configure" | "install";
  }

  return "install";
}

/** Release info returned by {@link fetchLatestRelease}. */
interface ReleaseInfo {
  version: string;
  downloadUrl: string;
}

/**
 * Fetch the latest signal-cli release from GitHub.
 *
 * @param spinner - Active spinner to update on failure
 * @returns Release info with version and download URL, or undefined on failure
 */
async function fetchLatestRelease(
  spinner: ReturnType<typeof p.spinner>,
): Promise<ReleaseInfo | undefined> {
  const response = await fetch(
    "https://api.github.com/repos/AsamK/signal-cli/releases/latest",
  );

  if (!response.ok) {
    spinner.stop("Failed to fetch release info");
    p.log.error(`GitHub API returned ${response.status}. Install manually from:`);
    p.log.info("https://github.com/AsamK/signal-cli/releases");
    return undefined;
  }

  const release = (await response.json()) as {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
  };
  const version = release.tag_name.replace(/^v/, "");

  const asset = release.assets.find(
    (a) => a.name.includes("signal-cli") && a.name.endsWith(".tar.gz"),
  );

  if (!asset) {
    spinner.stop("No downloadable asset found");
    p.log.error("Could not find signal-cli tar.gz in release assets.");
    p.log.info(`Download manually: https://github.com/AsamK/signal-cli/releases/tag/v${version}`);
    return undefined;
  }

  return { version, downloadUrl: asset.browser_download_url };
}

/**
 * Download and install signal-cli from a release URL.
 *
 * @param downloadUrl - URL of the tar.gz asset
 * @param version - Version string for log messages
 * @param spinner - Active spinner to update during download
 */
function downloadAndInstall(
  downloadUrl: string,
  version: string,
  spinner: ReturnType<typeof p.spinner>,
): void {
  const installDir = "/opt/signal-cli";
  const tmpPath = "/tmp/signal-cli.tar.gz";

  spinner.message(`Downloading signal-cli ${version}...`);

  // Download to temp file (URL is a data argument, not shell-interpolated)
  const downloadResult = tryExecFile("curl", ["-sL", "-o", tmpPath, downloadUrl]);
  if (downloadResult === undefined) {
    spinner.stop("Download failed");
    p.log.error("Failed to download signal-cli.");
    p.log.info(`Try manually:\n  curl -sL "${downloadUrl}" | sudo tar xz -C /opt/`);
    return;
  }

  // Extract from temp file
  const extractResult = tryExecFile("sudo", ["tar", "xz", "-C", "/opt/", "-f", tmpPath]);
  if (extractResult === undefined) {
    spinner.stop("Extraction failed");
    p.log.error("Failed to extract signal-cli archive.");
    p.log.info(`Try manually:\n  sudo tar xz -C /opt/ -f ${tmpPath}`);
    // Best-effort cleanup
    tryExecFile("rm", ["-f", tmpPath]);
    return;
  }

  // Cleanup temp file (best-effort)
  tryExecFile("rm", ["-f", tmpPath]);

  // Create symlink
  tryExecFile("sudo", ["ln", "-sf", installDir + "/bin/signal-cli", "/usr/local/bin/signal-cli"]);

  spinner.stop(`signal-cli ${version} installed to ${installDir}`);

  // Verify installation
  const verifyOutput = tryExecFile("signal-cli", ["--version"]);
  if (verifyOutput) {
    p.log.success(`Verified: ${verifyOutput.trim()}`);
  }
}

/**
 * Step 3: Download and install signal-cli.
 *
 * @returns true if installation succeeded or was skipped, false if aborted
 */
async function installSignalCli(): Promise<boolean> {
  const method = await p.select({
    message: "Installation method:",
    options: [
      { value: "download", label: "Download latest release from GitHub" },
      { value: "skip", label: "Skip (already installed elsewhere)" },
    ],
  });

  if (p.isCancel(method)) return false;

  if (method === "skip") {
    p.log.info("Skipping installation. Ensure signal-cli is in your PATH.");
    return true;
  }

  const spinner = p.spinner();
  spinner.start("Fetching latest signal-cli release...");

  try {
    const release = await fetchLatestRelease(spinner);
    if (!release) return true; // Don't block -- user can install manually

    downloadAndInstall(release.downloadUrl, release.version, spinner);
    return true;
  } catch (err) {
    spinner.stop("Installation failed");
    const msg = err instanceof Error ? err.message : String(err);
    p.log.error(`Installation error: ${msg}`);
    p.log.info("Install signal-cli manually: https://github.com/AsamK/signal-cli/releases");
    return true; // Don't block further configuration
  }
}

/**
 * Send a signal-cli registration request and verify the received code.
 *
 * @param phone - E.164 phone number to register
 * @param voiceFlag - Empty string for SMS, " --voice" for voice call
 * @returns true if verification succeeded, false on failure
 */
async function sendAndVerifyCode(phone: string, useVoice: boolean): Promise<boolean> {
  const spinner = p.spinner();
  spinner.start("Sending verification code...");

  const registerArgs = ["-u", phone, "register", ...(useVoice ? ["--voice"] : [])];
  const registerResult = tryExecFile("signal-cli", registerArgs);

  if (registerResult === undefined) {
    spinner.stop("Registration request failed");
    p.log.error("Failed to send verification code.");
    p.log.info(`Try manually: signal-cli -u ${phone} register${useVoice ? " --voice" : ""}`);
    return false;
  }

  spinner.stop("Verification code sent");

  const codeResult = await p.text({
    message: "Enter the 6-digit verification code:",
    validate: (value) => {
      if (!value || !VERIFY_CODE_REGEX.test(value)) {
        return "Must be a 6-digit number";
      }
      return undefined;
    },
  });

  if (p.isCancel(codeResult)) return false;
  const code = codeResult as string;

  spinner.start("Verifying code...");
  const verifyResult = tryExecFile("signal-cli", ["-u", phone, "verify", code]);

  if (verifyResult === undefined) {
    spinner.stop("Verification failed");
    p.log.error("Code verification failed. Check the code and try again.");
    p.log.info(`Try manually: signal-cli -u ${phone} verify ${code}`);
    return false;
  }

  spinner.stop("Phone number verified");
  return true;
}

/**
 * Step 4: Register phone number with Signal.
 *
 * @returns Phone number string if registration succeeded, undefined if aborted
 */
async function registerPhone(): Promise<string | undefined> {
  const phoneResult = await p.text({
    message: "Phone number (E.164 format, e.g., +15551234567):",
    validate: (value) => {
      if (!value || !E164_REGEX.test(value)) {
        return "Must be in E.164 format: + followed by country code and number";
      }
      return undefined;
    },
  });

  if (p.isCancel(phoneResult)) return undefined;
  const phone = phoneResult as string;

  const verifyMethod = await p.select({
    message: "Verification method:",
    options: [
      { value: "sms", label: "SMS" },
      { value: "voice", label: "Voice call" },
    ],
  });

  if (p.isCancel(verifyMethod)) return undefined;

  const useVoice = verifyMethod === "voice";
  const verified = await sendAndVerifyCode(phone, useVoice);

  return verified ? phone : undefined;
}

/**
 * Step 5: Send a test message to verify the setup.
 *
 * @param phone - Registered phone number
 */
async function verifySetup(phone: string): Promise<void> {
  const spinner = p.spinner();
  spinner.start("Sending test message...");

  const sendResult = tryExecFile("signal-cli", ["-u", phone, "send", "-m", "Comis test", phone]);

  if (sendResult === undefined) {
    spinner.stop("Test message failed");
    p.log.warning(
      "Could not send test message. This may be normal if you just registered.\n" +
      `  Try manually: signal-cli -u ${phone} send -m "test" ${phone}`,
    );
    return;
  }

  spinner.stop("Test message sent to self");
}

/**
 * Run the full Signal CLI setup flow.
 *
 * Orchestrates the 5 setup steps: Java check, signal-cli detection,
 * installation, phone registration, and verification.
 */
async function runSignalSetup(): Promise<void> {
  // Require interactive terminal
  if (!process.stdin.isTTY) {
    console.error("Signal setup requires an interactive terminal");
    process.exit(1);
  }

  p.intro("Signal CLI Setup");

  // Step 1: Check Java
  p.log.step("Step 1: Java prerequisite check");
  const javaOk = await checkJava();
  if (!javaOk) {
    p.cancel("Setup cancelled.");
    return;
  }

  // Step 2: Check existing signal-cli
  p.log.step("Step 2: signal-cli installation check");
  const action = await checkSignalCli();
  if (action === "abort") {
    p.cancel("Setup cancelled.");
    return;
  }

  // Step 3: Install if needed
  if (action === "install") {
    p.log.step("Step 3: Installing signal-cli");
    const installed = await installSignalCli();
    if (!installed) {
      p.cancel("Setup cancelled.");
      return;
    }
  }

  // Step 4: Register phone number
  p.log.step("Step 4: Phone number registration");
  const phone = await registerPhone();
  if (!phone) {
    p.cancel("Setup cancelled.");
    return;
  }

  // Step 5: Verify
  p.log.step("Step 5: Verification");
  await verifySetup(phone);

  p.outro(
    "Signal CLI configured! Add the Signal channel to your config with:\n" +
    "  comis configure --section channels",
  );
}

/**
 * Register the `signal-setup` command on the program.
 *
 * Provides a guided interactive setup for Signal CLI installation,
 * phone registration, and verification.
 *
 * @param program - The root Commander program
 */
export function registerSignalSetupCommand(program: Command): void {
  program
    .command("signal-setup")
    .description("Install and configure Signal CLI for the Signal channel adapter")
    .action(runSignalSetup);
}
