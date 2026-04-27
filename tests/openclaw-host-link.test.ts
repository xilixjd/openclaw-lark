import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureOpenClawPackageResolution,
  inferOpenClawHostRootFromPluginRoot,
  resolvePluginRootFromEntryUrl,
} from '../src/bootstrap/openclaw-host-link';

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true }));
  }
});

describe('openclaw host link bootstrap', () => {
  it('infers host root from the extension install path', () => {
    const pluginRoot = path.join('/openclaw', '.openclaw', 'extensions', 'openclaw-lark');
    expect(inferOpenClawHostRootFromPluginRoot(pluginRoot)).toBe('/openclaw');
  });

  it('resolves plugin root from the built entry url', () => {
    const entryUrl = new URL('file:///tmp/example/.openclaw/extensions/openclaw-lark/dist/index.mjs').href;
    expect(resolvePluginRootFromEntryUrl(entryUrl)).toBe('/tmp/example/.openclaw/extensions/openclaw-lark');
  });

  it('links the host openclaw package into the plugin directory when missing', async () => {
    const hostRoot = await createTempDir('openclaw-host-');
    await writeFile(
      path.join(hostRoot, 'package.json'),
      JSON.stringify({ name: 'openclaw', version: '0.0.0-test' }, null, 2),
    );

    const pluginRoot = path.join(hostRoot, '.openclaw', 'extensions', 'openclaw-lark');
    await mkdir(path.join(pluginRoot, 'dist'), { recursive: true });
    await writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({ name: 'plugin-under-test' }, null, 2));

    const previousCwd = process.cwd();
    const previousArgv1 = process.argv[1];
    const previousHostRoot = process.env.OPENCLAW_HOST_ROOT;

    process.chdir(hostRoot);
    process.argv[1] = path.join(hostRoot, 'dist', 'index.js');
    process.env.OPENCLAW_HOST_ROOT = hostRoot;

    try {
      await ensureOpenClawPackageResolution(new URL(`file://${path.join(pluginRoot, 'dist', 'index.mjs')}`).href);

      const linkPath = path.join(pluginRoot, 'node_modules', 'openclaw');
      const linkTarget = await readFile(path.join(linkPath, 'package.json'), 'utf8');
      expect(JSON.parse(linkTarget).name).toBe('openclaw');
    } finally {
      process.chdir(previousCwd);
      process.argv[1] = previousArgv1;
      if (previousHostRoot === undefined) {
        delete process.env.OPENCLAW_HOST_ROOT;
      } else {
        process.env.OPENCLAW_HOST_ROOT = previousHostRoot;
      }
    }
  });

  it('finds a globally installed openclaw package from the bin path', async () => {
    const nodeRoot = await createTempDir('openclaw-node-root-');
    const hostRoot = path.join(nodeRoot, 'lib', 'node_modules', 'openclaw');
    await mkdir(hostRoot, { recursive: true });
    await writeFile(
      path.join(hostRoot, 'package.json'),
      JSON.stringify({ name: 'openclaw', version: '0.0.0-test' }, null, 2),
    );

    const pluginRoot = await createTempDir('openclaw-plugin-');
    await mkdir(path.join(pluginRoot, 'dist'), { recursive: true });
    await writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({ name: 'plugin-under-test' }, null, 2));

    const previousCwd = process.cwd();
    const previousArgv1 = process.argv[1];
    const previousHostRoot = process.env.OPENCLAW_HOST_ROOT;

    process.chdir(await createTempDir('openclaw-deploy-'));
    process.argv[1] = path.join(nodeRoot, 'bin', 'openclaw');
    delete process.env.OPENCLAW_HOST_ROOT;

    try {
      await ensureOpenClawPackageResolution(new URL(`file://${path.join(pluginRoot, 'dist', 'index.mjs')}`).href);

      const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'node_modules', 'openclaw', 'package.json'), 'utf8'));
      expect(manifest.name).toBe('openclaw');
    } finally {
      process.chdir(previousCwd);
      process.argv[1] = previousArgv1;
      if (previousHostRoot === undefined) {
        delete process.env.OPENCLAW_HOST_ROOT;
      } else {
        process.env.OPENCLAW_HOST_ROOT = previousHostRoot;
      }
    }
  });

  it('keeps an existing openclaw link intact', async () => {
    const hostRoot = await createTempDir('openclaw-host-existing-');
    await writeFile(
      path.join(hostRoot, 'package.json'),
      JSON.stringify({ name: 'openclaw', version: '0.0.0-test' }, null, 2),
    );

    const pluginRoot = path.join(hostRoot, '.openclaw', 'extensions', 'openclaw-lark');
    await mkdir(path.join(pluginRoot, 'node_modules'), { recursive: true });
    await writeFile(path.join(pluginRoot, 'package.json'), JSON.stringify({ name: 'plugin-under-test' }, null, 2));
    await symlink(path.relative(path.join(pluginRoot, 'node_modules'), hostRoot), path.join(pluginRoot, 'node_modules', 'openclaw'));

    await ensureOpenClawPackageResolution(new URL(`file://${path.join(pluginRoot, 'dist', 'index.mjs')}`).href);

    const manifest = JSON.parse(await readFile(path.join(pluginRoot, 'node_modules', 'openclaw', 'package.json'), 'utf8'));
    expect(manifest.name).toBe('openclaw');
  });
});
