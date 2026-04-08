import fs from 'node:fs';
import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClawdbotConfig, PluginRuntime } from 'openclaw/plugin-sdk';
import {
  bootstrapDynamicAgent,
  consumeDynamicSkillsDeltaNote,
  ensureDynamicAgentListedForRuntime,
  resetDynamicAgentStateForTests,
  resolveDynamicAgentRouteOverride,
} from '../src/messaging/inbound/dynamic-agent';

function makeBaseRoute() {
  return {
    agentId: 'main',
    channel: 'feishu',
    accountId: 'default',
    sessionKey: 'agent:main',
    mainSessionKey: 'agent:main:main',
    lastRoutePolicy: 'session' as const,
    matchedBy: 'default' as const,
  };
}

async function applyDynamicRoutingInCaller(params: {
  cfg: ClawdbotConfig;
  route: Parameters<typeof resolveDynamicAgentRouteOverride>[0]['route'];
  accountId: string;
  senderId: string;
  chatType: 'dm' | 'group';
  peerId: string;
  runtime: PluginRuntime;
}): Promise<string | undefined> {
  const override = resolveDynamicAgentRouteOverride({
    cfg: params.cfg,
    route: params.route,
    accountId: params.accountId,
    senderId: params.senderId,
    chatType: params.chatType,
    peerId: params.peerId,
  });
  if (!override) return undefined;

  bootstrapDynamicAgent({
    cfg: params.cfg,
    dynamicAgentId: override.agentId,
    sourceAgentId: override.sourceAgentId,
  });

  params.route.agentId = override.agentId;
  params.route.sessionKey = override.sessionKey;
  params.route.mainSessionKey = override.mainSessionKey;
  params.route.lastRoutePolicy = override.lastRoutePolicy;

  await ensureDynamicAgentListedForRuntime({
    agentId: override.agentId,
    runtime: params.runtime,
    accountId: params.accountId,
  });
  return override.agentId;
}

describe('dynamic-agent routing', () => {
  const root = path.join('/tmp', `openclaw-lark-dynamic-agent-${process.pid}`);
  const watchCallbacks = new Map<string, fs.WatchListener<string>>();

  beforeEach(() => {
    watchCallbacks.clear();
    vi.spyOn(fs, 'watch').mockImplementation(((target: fs.PathLike, listener: fs.WatchListener<string>) => {
      watchCallbacks.set(path.resolve(String(target)), listener);
      return {
        close: vi.fn(),
        on: vi.fn().mockReturnThis(),
      } as unknown as fs.FSWatcher;
    }) as typeof fs.watch);
  });

  afterEach(async () => {
    resetDynamicAgentStateForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('applies DM dynamic routing and seeds workspace/agent dirs from source workspace', async () => {
    vi.stubEnv('OPENCLAW_STATE_DIR', root);

    const sourceWorkspace = path.join(root, 'workspace-main');
    const sourceSkillDir = path.join(sourceWorkspace, 'skills', 'example-skill');
    await mkdir(sourceSkillDir, { recursive: true });
    await writeFile(path.join(sourceWorkspace, 'AGENTS.md'), 'source agents');
    await writeFile(path.join(sourceSkillDir, 'SKILL.md'), 'version 1');

    let liveCfg: ClawdbotConfig = {
      channels: {
        feishu: {
          dynamicAgents: { enabled: true, workspaceSeed: true },
        },
      },
      agents: {
        list: [{ id: 'main' }],
      },
    } as unknown as ClawdbotConfig;

    const runtime = {
      config: {
        loadConfig: vi.fn(() => liveCfg),
        writeConfigFile: vi.fn(async (next: unknown) => {
          liveCfg = next as ClawdbotConfig;
        }),
      },
    } as unknown as PluginRuntime;

    const route = makeBaseRoute();
    const applied = await applyDynamicRoutingInCaller({
      cfg: liveCfg,
      route,
      accountId: 'default',
      senderId: 'ou_UserA',
      chatType: 'dm',
      peerId: 'ou_UserA',
      runtime,
    });

    expect(applied).toBe('feishu-default-dm-ou_usera');
    expect(route.agentId).toBe('feishu-default-dm-ou_usera');
    expect(route.sessionKey).toContain('feishu-default-dm-ou_usera');

    const listed =
      ((liveCfg as unknown as { agents?: { list?: Array<{ id?: string; workspace?: string }> } })?.agents?.list ?? []).find(
        (entry) => entry?.id === route.agentId,
      );
    expect(listed).toMatchObject({
      id: route.agentId,
      workspace: path.join(root, `workspace-${route.agentId}`),
      default: false,
    });

    expect(fs.existsSync(path.join(root, 'agents', route.agentId, 'agent'))).toBe(true);
    await expect(readFile(path.join(root, `workspace-${route.agentId}`, 'AGENTS.md'), 'utf8')).resolves.toBe(
      'source agents',
    );
    await expect(
      readFile(path.join(root, `workspace-${route.agentId}`, 'skills', 'example-skill', 'SKILL.md'), 'utf8'),
    ).resolves.toBe('version 1');
  });

  it('keeps source route when sender is dynamic-agent admin', async () => {
    const cfg = {
      channels: {
        feishu: {
          dynamicAgents: { enabled: true, adminUsers: ['ou_admin'] },
        },
      },
      agents: {
        list: [{ id: 'main' }],
      },
    } as unknown as ClawdbotConfig;

    const route = makeBaseRoute();
    const runtime = {
      config: {
        loadConfig: vi.fn(() => cfg),
        writeConfigFile: vi.fn(),
      },
    } as unknown as PluginRuntime;

    const applied = await applyDynamicRoutingInCaller({
      cfg,
      route,
      accountId: 'default',
      senderId: 'OU_ADMIN',
      chatType: 'dm',
      peerId: 'OU_ADMIN',
      runtime,
    });

    expect(applied).toBeUndefined();
    expect(route.agentId).toBe('main');
    expect(route.sessionKey).toBe('agent:main');
  });

  it('injects skills runtime note on next non-command message only', async () => {
    vi.stubEnv('OPENCLAW_STATE_DIR', root);

    const sourceWorkspace = path.join(root, 'workspace-main');
    const sourceSkillDir = path.join(sourceWorkspace, 'skills', 'example-skill');
    await mkdir(sourceSkillDir, { recursive: true });
    await writeFile(path.join(sourceWorkspace, 'AGENTS.md'), 'source agents');
    await writeFile(path.join(sourceSkillDir, 'SKILL.md'), 'version 1');

    const cfg = {
      channels: {
        feishu: {
          dynamicAgents: { enabled: true, workspaceSeed: true },
        },
      },
      agents: {
        list: [{ id: 'main' }],
      },
    } as unknown as ClawdbotConfig;

    const runtime = {
      config: {
        loadConfig: vi.fn(() => cfg),
        writeConfigFile: vi.fn(),
      },
    } as unknown as PluginRuntime;

    const route = makeBaseRoute();
    const applied = await applyDynamicRoutingInCaller({
      cfg,
      route,
      accountId: 'default',
      senderId: 'ou_skill_user',
      chatType: 'dm',
      peerId: 'ou_skill_user',
      runtime,
    });
    expect(applied).toBe(route.agentId);

    const targetSkillFile = path.join(root, `workspace-${route.agentId}`, 'skills', 'example-skill', 'SKILL.md');
    await writeFile(targetSkillFile, 'version 2');
    const watchedChildDir = path.resolve(path.dirname(targetSkillFile));
    watchCallbacks.get(watchedChildDir)?.('change', 'SKILL.md');

    const note = consumeDynamicSkillsDeltaNote(route.agentId);
    expect(note).toContain('[Runtime note: workspace skills changed]');
    expect(note).toContain('example-skill');

    const second = consumeDynamicSkillsDeltaNote(route.agentId);
    expect(second).toBeUndefined();
  });

  it('creates dynamic agent directory when dynamic route is enabled', async () => {
    vi.stubEnv('OPENCLAW_STATE_DIR', root);

    const sourceWorkspace = path.join(root, 'workspace-main');
    await mkdir(sourceWorkspace, { recursive: true });
    await writeFile(path.join(sourceWorkspace, 'AGENTS.md'), 'source agents');

    const cfg = {
      channels: {
        feishu: {
          dynamicAgents: { enabled: true },
        },
      },
      agents: {
        list: [{ id: 'main' }],
      },
    } as unknown as ClawdbotConfig;

    const runtime = {
      config: {
        loadConfig: vi.fn(() => cfg),
        writeConfigFile: vi.fn(),
      },
    } as unknown as PluginRuntime;

    const route = makeBaseRoute();
    await applyDynamicRoutingInCaller({
      cfg,
      route,
      accountId: 'default',
      senderId: 'ou_user_b',
      chatType: 'dm',
      peerId: 'ou_user_b',
      runtime,
    });

    expect(fs.existsSync(path.join(root, 'agents', route.agentId, 'agent'))).toBe(true);
    expect(fs.existsSync(path.join(root, `workspace-${route.agentId}`))).toBe(true);
  });
});
