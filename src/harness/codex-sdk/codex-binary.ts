// The vendored Codex CLI binary: the one `@openai/codex-sdk` runs for a
// session (`codex exec`), resolved the way the SDK resolves it — the
// `@openai/codex` package names the platform package, the platform package
// ships `vendor/<triple>/bin/codex` (or, in older layouts, `codex/codex`) —
// so that anything the app asks the CLI outside a session (the app-server
// reading the plan's limits, app-server.ts) runs the very same binary and
// version as the sessions do. The SDK keeps its resolver private; this one
// is its mirror for the targets Balabash runs on.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
};

function targetTriple(): string | null {
  const { platform, arch } = process;

  if (platform === 'linux' || platform === 'android') {
    return arch === 'x64' ? 'x86_64-unknown-linux-musl' : arch === 'arm64' ? 'aarch64-unknown-linux-musl' : null;
  }

  if (platform === 'darwin') {
    return arch === 'x64' ? 'x86_64-apple-darwin' : arch === 'arm64' ? 'aarch64-apple-darwin' : null;
  }

  return null;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export type CodexBinary = {
  executablePath: string;
  // Directories the SDK puts in front of PATH for the CLI (the bundled
  // helpers of the platform package).
  pathDirs: string[];
};

// Throws when the platform is not one Balabash runs on or the packages are
// not installed with their optional platform dependency.
export function codexBinary(): CodexBinary {
  const triple = targetTriple();

  if (!triple) {
    throw new Error(`Unsupported platform for the Codex CLI: ${process.platform} (${process.arch})`);
  }

  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[triple]!;
  let vendorRoot: string;

  try {
    const codexPackageJson = createRequire(import.meta.url).resolve('@openai/codex/package.json');
    const platformPackageJson = createRequire(codexPackageJson).resolve(`${platformPackage}/package.json`);

    vendorRoot = path.join(path.dirname(platformPackageJson), 'vendor');
  } catch {
    throw new Error(`Unable to locate the Codex CLI: ${platformPackage} is not installed`);
  }

  const packageRoot = path.join(vendorRoot, triple);
  const packaged = path.join(packageRoot, 'bin', 'codex');

  if (isFile(packaged) && isFile(path.join(packageRoot, 'codex-package.json'))) {
    return { executablePath: packaged, pathDirs: [path.join(packageRoot, 'codex-path')].filter(isDirectory) };
  }

  const legacy = path.join(packageRoot, 'codex', 'codex');

  if (isFile(legacy)) {
    return { executablePath: legacy, pathDirs: [path.join(packageRoot, 'path')].filter(isDirectory) };
  }

  throw new Error(`Unable to locate the Codex CLI binary for ${triple} under ${vendorRoot}`);
}
