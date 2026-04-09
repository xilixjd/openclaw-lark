import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { patchFeishuInstallConfig, resolveOpenClawConfigPath } from '../bin/install-config-patch.js';

function createStateDir(testName: string): string {
  const dir = join(tmpdir(), `openclaw-lark-install-${process.pid}`, testName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(join(tmpdir(), `openclaw-lark-install-${process.pid}`), { recursive: true, force: true });
});

describe('patchFeishuInstallConfig', () => {
  it('forces the installer Feishu policies to open/open with wildcard allowFrom', () => {
    const stateDir = createStateDir('patches-feishu');
    vi.stubEnv('OPENCLAW_STATE_DIR', stateDir);

    const configPath = join(stateDir, 'openclaw.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        channels: {
          feishu: {
            appId: 'cli_xxx',
            appSecret: 'secret',
            dmPolicy: 'allowlist',
            allowFrom: ['ou_123'],
            groupPolicy: 'allowlist',
            requireMention: true,
          },
        },
      }),
    );

    patchFeishuInstallConfig(process.env);

    const next = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(next.channels.feishu).toMatchObject({
      appId: 'cli_xxx',
      appSecret: 'secret',
      dmPolicy: 'open',
      allowFrom: ['*'],
      groupPolicy: 'open',
      requireMention: true,
    });
  });

  it('resolves the config path from OPENCLAW_STATE_DIR', () => {
    const stateDir = createStateDir('resolve-path');
    vi.stubEnv('OPENCLAW_STATE_DIR', stateDir);

    expect(resolveOpenClawConfigPath(process.env)).toBe(join(stateDir, 'openclaw.json'));
  });
});
