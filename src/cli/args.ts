import { CliError } from "./errors.js";
import { getSupportedPlatforms, isSupportedPlatform, type PlatformInput } from "../core/platform/install.js";

export interface CliFlags {
  all?: boolean;
  agents?: boolean;
  claude?: boolean;
  codex?: boolean;
  dryRun?: boolean;
  force?: boolean;
  help?: boolean;
  input?: string;
  json?: boolean;
  noInteractive?: boolean;
  packageManager?: string;
  platformOnly?: boolean;
  projectOnly?: boolean;
  projectRoot?: string;
  skipExisting?: boolean;
  strict?: boolean;
  version?: boolean;
  yes?: boolean;
}

export interface ParsedArgs {
  command: string;
  flags: CliFlags;
  positionals: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: CliFlags = {};
  const positionals: string[] = [];
  let command = "init";
  let commandSet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("-") && !commandSet) {
      command = arg;
      commandSet = true;
      continue;
    }

    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }

    if (arg === "--project-root" || arg === "-C") {
      flags.projectRoot = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--input" || arg === "-i") {
      flags.input = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--json") {
      flags.json = true;
      continue;
    }

    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
      continue;
    }

    if (arg === "--no-interactive") {
      flags.noInteractive = true;
      continue;
    }

    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }

    if (arg === "--force") {
      flags.force = true;
      continue;
    }

    if (arg === "--skip-existing") {
      flags.skipExisting = true;
      continue;
    }

    if (arg === "--platform-only") {
      flags.platformOnly = true;
      continue;
    }

    if (arg === "--project-only") {
      flags.projectOnly = true;
      continue;
    }

    if (arg === "--strict") {
      flags.strict = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      flags.version = true;
      continue;
    }

    if (arg === "--pm" || arg === "--package-manager") {
      flags.packageManager = argv[index + 1];
      index += 1;
      continue;
    }

    const platform = arg.slice(2);
    if (arg.startsWith("--") && isPlatformFlagName(platform)) {
      setPlatformFlag(flags, platform);
      continue;
    }

    throw new CliError(`未知参数: ${arg}`, 2);
  }

  return { command, flags, positionals };
}

function isPlatformFlagName(value: string): value is PlatformInput {
  return value === "all" || isSupportedPlatform(value);
}

function setPlatformFlag(flags: CliFlags, platform: PlatformInput): void {
  if (platform === "all") {
    flags.all = true;
    return;
  }
  flags[platform] = true;
}

export function collectPlatforms(flags: CliFlags): PlatformInput[] {
  if (flags.all) {
    return ["all"];
  }

  return getSupportedPlatforms().filter((platform) => flags[platform]);
}
