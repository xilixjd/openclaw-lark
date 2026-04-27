import { access, lstat, mkdir, readFile, symlink } from 'node:fs/promises';
import { accessSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const STATE_DIR_MARKERS = ['.openclaw', '.clawdbot', '.moldbot'];

function normalizeCandidatePath(input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) return undefined;
  return path.resolve(trimmed);
}

function resolveRealPath(input: string | undefined): string | undefined {
  const resolved = normalizeCandidatePath(input);
  if (!resolved) return undefined;

  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function resolvePluginRootFromEntryUrl(entryUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(entryUrl)), '..');
}

export function inferOpenClawHostRootFromPluginRoot(pluginRoot: string): string | undefined {
  const resolved = path.resolve(pluginRoot);
  for (const marker of STATE_DIR_MARKERS) {
    const token = `${path.sep}${marker}${path.sep}`;
    const index = resolved.lastIndexOf(token);
    if (index > 0) {
      return resolved.slice(0, index);
    }
  }
  return undefined;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function pathExistsSync(targetPath: string): boolean {
  try {
    accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isOpenClawPackageRoot(candidateRoot: string): Promise<boolean> {
  const manifestPath = path.join(candidateRoot, 'package.json');
  if (!(await pathExists(manifestPath))) return false;

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: unknown };
    return manifest.name === 'openclaw';
  } catch {
    return false;
  }
}

function isOpenClawPackageRootSync(candidateRoot: string): boolean {
  const manifestPath = path.join(candidateRoot, 'package.json');
  if (!pathExistsSync(manifestPath)) return false;

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown };
    return manifest.name === 'openclaw';
  } catch {
    return false;
  }
}

function collectHostRootCandidates(pluginRoot: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (candidate: string | undefined) => {
    const resolved = normalizeCandidatePath(candidate);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  };

  const addExecutableCandidates = (executablePath: string | undefined) => {
    const executable = normalizeCandidatePath(executablePath);
    if (!executable) return;

    add(path.dirname(executable));

    const realExecutable = resolveRealPath(executable);
    if (realExecutable && realExecutable !== executable) {
      add(path.dirname(realExecutable));
    }

    for (const candidate of [executable, realExecutable]) {
      if (!candidate) continue;
      const binDir = path.dirname(candidate);
      const prefixDir = path.basename(binDir) === 'bin' ? path.dirname(binDir) : undefined;
      add(prefixDir ? path.join(prefixDir, 'lib', 'node_modules', 'openclaw') : undefined);
    }
  };

  add(process.env.OPENCLAW_HOST_ROOT);
  add(process.env.OPENCLAW_ROOT);
  add(inferOpenClawHostRootFromPluginRoot(pluginRoot));

  addExecutableCandidates(process.argv[1]);
  add(process.cwd());
  addExecutableCandidates(process.execPath);

  return out;
}

async function findHostOpenClawRoot(pluginRoot: string): Promise<string | undefined> {
  for (const candidate of collectHostRootCandidates(pluginRoot)) {
    if (await isOpenClawPackageRoot(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findHostOpenClawRootSync(pluginRoot: string): string | undefined {
  for (const candidate of collectHostRootCandidates(pluginRoot)) {
    if (isOpenClawPackageRootSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function canResolveOpenClawFrom(pluginRoot: string): Promise<boolean> {
  if (await isOpenClawPackageRoot(path.join(pluginRoot, 'node_modules', 'openclaw'))) return true;

  try {
    const requireFromPlugin = createRequire(path.join(pluginRoot, 'package.json'));
    requireFromPlugin.resolve('openclaw/plugin-sdk');
    return true;
  } catch {
    return false;
  }
}

function canResolveOpenClawFromSync(pluginRoot: string): boolean {
  if (isOpenClawPackageRootSync(path.join(pluginRoot, 'node_modules', 'openclaw'))) return true;

  try {
    const requireFromPlugin = createRequire(path.join(pluginRoot, 'package.json'));
    requireFromPlugin.resolve('openclaw/plugin-sdk');
    return true;
  } catch {
    return false;
  }
}

async function ensureOpenClawSymlink(pluginRoot: string, hostRoot: string): Promise<void> {
  const nodeModulesDir = path.join(pluginRoot, 'node_modules');
  const linkPath = path.join(nodeModulesDir, 'openclaw');

  try {
    const stat = await lstat(linkPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) return;
  } catch {
    // Missing link is expected on first run.
  }

  await mkdir(nodeModulesDir, { recursive: true });
  const linkTarget = path.relative(nodeModulesDir, hostRoot) || '.';
  await symlink(linkTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function ensureOpenClawSymlinkSync(pluginRoot: string, hostRoot: string): void {
  const nodeModulesDir = path.join(pluginRoot, 'node_modules');
  const linkPath = path.join(nodeModulesDir, 'openclaw');

  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink() || stat.isDirectory()) return;
  } catch {
    // Missing link is expected on first run.
  }

  mkdirSync(nodeModulesDir, { recursive: true });
  const linkTarget = path.relative(nodeModulesDir, hostRoot) || '.';
  symlinkSync(linkTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

function buildOpenClawResolutionError(pluginRoot: string): Error {
  return new Error(
    [
      'Unable to resolve runtime package "openclaw" for the Feishu plugin.',
      `pluginRoot=${pluginRoot}`,
      `cwd=${process.cwd()}`,
      `argv1=${process.argv[1] ?? ''}`,
      'Set OPENCLAW_HOST_ROOT to the OpenClaw package root if the host layout is non-standard.',
    ].join(' '),
  );
}

export async function ensureOpenClawPackageResolution(entryUrl: string): Promise<void> {
  const pluginRoot = resolvePluginRootFromEntryUrl(entryUrl);
  if (await canResolveOpenClawFrom(pluginRoot)) return;

  const hostRoot = await findHostOpenClawRoot(pluginRoot);
  if (!hostRoot) {
    throw buildOpenClawResolutionError(pluginRoot);
  }

  await ensureOpenClawSymlink(pluginRoot, hostRoot);

  if (!(await canResolveOpenClawFrom(pluginRoot))) {
    throw new Error(`Linked host OpenClaw package but resolution still failed: ${hostRoot}`);
  }
}

export function ensureOpenClawPackageResolutionSync(entryUrl: string): void {
  const pluginRoot = resolvePluginRootFromEntryUrl(entryUrl);
  if (canResolveOpenClawFromSync(pluginRoot)) return;

  const hostRoot = findHostOpenClawRootSync(pluginRoot);
  if (!hostRoot) {
    throw buildOpenClawResolutionError(pluginRoot);
  }

  ensureOpenClawSymlinkSync(pluginRoot, hostRoot);

  if (!canResolveOpenClawFromSync(pluginRoot)) {
    throw new Error(`Linked host OpenClaw package but resolution still failed: ${hostRoot}`);
  }
}
