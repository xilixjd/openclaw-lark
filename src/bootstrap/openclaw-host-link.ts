import { access, lstat, mkdir, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const STATE_DIR_MARKERS = ['.openclaw', '.clawdbot', '.moldbot'];

function normalizeCandidatePath(input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) return undefined;
  return path.resolve(trimmed);
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

function collectHostRootCandidates(pluginRoot: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (candidate: string | undefined) => {
    const resolved = normalizeCandidatePath(candidate);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  };

  add(process.env.OPENCLAW_HOST_ROOT);
  add(process.env.OPENCLAW_ROOT);
  add(inferOpenClawHostRootFromPluginRoot(pluginRoot));

  const argv1 = process.argv[1] ? path.dirname(process.argv[1]) : undefined;
  add(argv1);
  add(process.cwd());
  add(path.dirname(process.execPath));

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

async function canResolveOpenClawFrom(pluginRoot: string): Promise<boolean> {
  try {
    const requireFromPlugin = createRequire(path.join(pluginRoot, 'package.json'));
    requireFromPlugin.resolve('openclaw/package.json');
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

export async function ensureOpenClawPackageResolution(entryUrl: string): Promise<void> {
  const pluginRoot = resolvePluginRootFromEntryUrl(entryUrl);
  if (await canResolveOpenClawFrom(pluginRoot)) return;

  const hostRoot = await findHostOpenClawRoot(pluginRoot);
  if (!hostRoot) {
    throw new Error(
      [
        'Unable to resolve runtime package "openclaw" for the Feishu plugin.',
        `pluginRoot=${pluginRoot}`,
        `cwd=${process.cwd()}`,
        `argv1=${process.argv[1] ?? ''}`,
        'Set OPENCLAW_HOST_ROOT to the OpenClaw package root if the host layout is non-standard.',
      ].join(' '),
    );
  }

  await ensureOpenClawSymlink(pluginRoot, hostRoot);

  if (!(await canResolveOpenClawFrom(pluginRoot))) {
    throw new Error(`Linked host OpenClaw package but resolution still failed: ${hostRoot}`);
  }
}
