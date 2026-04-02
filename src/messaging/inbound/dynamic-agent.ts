/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Dynamic-agent helpers for Feishu inbound routing.
 *
 * Features:
 * - Optional per-user / per-group dynamic agent routing.
 * - First-use directory bootstrap (`agents/<id>/agent`, `workspace-<id>`).
 * - Optional workspace seed from source agent workspace.
 * - Workspace `skills/` watcher with one-shot runtime note injection.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClawdbotConfig, PluginRuntime } from 'openclaw/plugin-sdk';
import {
  DEFAULT_MAIN_KEY,
  buildAgentMainSessionKey,
  buildAgentSessionKey,
  deriveLastRoutePolicy,
} from 'openclaw/plugin-sdk/routing';
import { larkLogger } from '../../core/lark-logger';
import { registerShutdownHook } from '../../core/shutdown-hooks';

const log = larkLogger('inbound/dynamic-agent');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DynamicAgentConfig {
  enabled: boolean;
  dmCreateAgent: boolean;
  groupEnabled: boolean;
  adminUsers: string[];
  workspaceSeed: boolean;
}

type MutableResolvedRoute = ReturnType<PluginRuntime['channel']['routing']['resolveAgentRoute']>;

export interface DynamicAgentRouteOverride {
  agentId: string;
  sourceAgentId: string;
  sessionKey: string;
  mainSessionKey: string;
  lastRoutePolicy: 'main' | 'session';
}

interface DynamicSkillDelta {
  skillName: string;
  changeType: 'added' | 'updated' | 'removed';
  skillFilePath: string;
}

interface DynamicSkillsDeltaState {
  changes: Map<string, DynamicSkillDelta>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DYNAMIC_WORKSPACE_STANDARD_FILES = [
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'USER.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
];

// ---------------------------------------------------------------------------
// In-memory caches
// ---------------------------------------------------------------------------

const ensuredDynamicAgentIds = new Set<string>();
let ensureDynamicAgentWriteQueue: Promise<void> = Promise.resolve();

const dynamicSkillsRootWatchers = new Map<string, fs.FSWatcher>();
const dynamicSkillsChildWatchers = new Map<string, Map<string, fs.FSWatcher>>();
const dynamicSkillsWorkspaceDirs = new Map<string, string>();
const dynamicSkillsDeltaState = new Map<string, DynamicSkillsDeltaState>();

let dynamicAgentShutdownHookRegistered = false;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function normalizeConfigValue(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  return input as Record<string, unknown>;
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((item) => String(item)).filter((item) => item.trim().length > 0);
}

/**
 * Read dynamic-agent config from `channels.feishu.dynamicAgents`.
 */
export function getDynamicAgentConfig(cfg: ClawdbotConfig): DynamicAgentConfig {
  const feishuCfg = normalizeConfigValue(cfg?.channels?.feishu);
  const dynamic = normalizeConfigValue(feishuCfg?.dynamicAgents);

  return {
    enabled: dynamic?.enabled === true,
    dmCreateAgent: dynamic?.dmCreateAgent !== false,
    groupEnabled: dynamic?.groupEnabled !== false,
    adminUsers: normalizeStringArray(dynamic?.adminUsers),
    workspaceSeed: dynamic?.workspaceSeed !== false,
  };
}

function sanitizeDynamicIdPart(value: string): string {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
}

/**
 * Build deterministic dynamic agent ID:
 * `feishu-{accountId}-{dm|group}-{peerId}`
 */
export function generateDynamicAgentId(
  chatType: 'dm' | 'group',
  peerId: string,
  accountId?: string,
): string {
  const sanitizedPeer = sanitizeDynamicIdPart(peerId) || 'unknown';
  const sanitizedAccount = sanitizeDynamicIdPart(accountId ?? 'default') || 'default';
  return `feishu-${sanitizedAccount}-${chatType}-${sanitizedPeer}`;
}

/**
 * Whether current message should use dynamic-agent routing.
 */
export function shouldUseDynamicAgent(params: {
  chatType: 'dm' | 'group';
  senderId: string;
  cfg: ClawdbotConfig;
}): boolean {
  const dynamic = getDynamicAgentConfig(params.cfg);
  if (!dynamic.enabled) return false;

  const sender = String(params.senderId).trim().toLowerCase();
  const isAdmin = dynamic.adminUsers.some((entry) => entry.trim().toLowerCase() === sender);
  if (isAdmin) return false;

  if (params.chatType === 'group') {
    return dynamic.groupEnabled;
  }
  return dynamic.dmCreateAgent;
}

// ---------------------------------------------------------------------------
// Route injection
// ---------------------------------------------------------------------------

function buildDynamicSessionKey(params: {
  agentId: string;
  accountId: string;
  chatType: 'dm' | 'group';
  peerId: string;
}): string {
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: 'feishu',
    accountId: params.accountId,
    peer: {
      kind: params.chatType === 'group' ? 'group' : 'direct',
      id: params.peerId,
    },
  }).toLowerCase();
}

function buildDynamicMainSessionKey(agentId: string): string {
  return buildAgentMainSessionKey({
    agentId,
    mainKey: DEFAULT_MAIN_KEY,
  }).toLowerCase();
}

/**
 * Resolve route override values for dynamic-agent routing.
 *
 * This function is pure and has no side effects.
 */
export function resolveDynamicAgentRouteOverride(params: {
  cfg: ClawdbotConfig;
  route: MutableResolvedRoute;
  accountId: string;
  senderId: string;
  chatType: 'dm' | 'group';
  peerId: string;
}): DynamicAgentRouteOverride | undefined {
  const useDynamic = shouldUseDynamicAgent({
    chatType: params.chatType,
    senderId: params.senderId,
    cfg: params.cfg,
  });
  if (!useDynamic) return undefined;

  const sourceAgentId = params.route.agentId;
  const targetAgentId = generateDynamicAgentId(params.chatType, params.peerId, params.accountId);

  const sessionKey = buildDynamicSessionKey({
    agentId: targetAgentId,
    accountId: params.accountId,
    chatType: params.chatType,
    peerId: params.peerId,
  });
  const mainSessionKey = buildDynamicMainSessionKey(targetAgentId);

  return {
    agentId: targetAgentId,
    sourceAgentId,
    sessionKey,
    mainSessionKey,
    lastRoutePolicy: deriveLastRoutePolicy({ sessionKey, mainSessionKey }),
  };
}

// ---------------------------------------------------------------------------
// Config writes: agents.list
// ---------------------------------------------------------------------------

function findAccountConfigById(feishuCfg: Record<string, unknown>, accountId: string): Record<string, unknown> | undefined {
  const accounts = normalizeConfigValue(feishuCfg.accounts);
  if (!accounts) return undefined;
  const target = accountId.trim().toLowerCase();
  for (const [key, value] of Object.entries(accounts)) {
    if (key.trim().toLowerCase() === target) {
      return normalizeConfigValue(value);
    }
  }
  return undefined;
}

function canWriteFeishuConfig(cfg: ClawdbotConfig, accountId: string): boolean {
  const feishuCfg = normalizeConfigValue(cfg?.channels?.feishu);
  if (!feishuCfg) return true;

  const accountCfg = findAccountConfigById(feishuCfg, accountId);
  if (accountCfg?.configWrites === false) {
    return false;
  }
  if (feishuCfg.configWrites === false) {
    return false;
  }
  return true;
}

function upsertDynamicAgentIntoList(cfg: Record<string, unknown>, agentId: string): boolean {
  if (!cfg.agents || typeof cfg.agents !== 'object') {
    cfg.agents = {};
  }

  const agentsObj = cfg.agents as Record<string, unknown>;
  const currentList = Array.isArray(agentsObj.list) ? [...agentsObj.list] : [];
  const existing = new Set<string>();

  for (const entry of currentList) {
    if (entry && typeof entry === 'object') {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string' && id.trim()) {
        existing.add(id.trim().toLowerCase());
      }
    }
  }

  let changed = false;

  if (currentList.length === 0) {
    const defaultAgentId = resolveDefaultAgentIdFromConfig(cfg);
    currentList.push({ id: defaultAgentId });
    existing.add(defaultAgentId.trim().toLowerCase());
    changed = true;
  }

  if (!existing.has(agentId.trim().toLowerCase())) {
    currentList.push({ id: agentId });
    changed = true;
  }

  if (changed) {
    agentsObj.list = currentList;
  }
  return changed;
}

function resolveDefaultAgentIdFromConfig(cfg: Record<string, unknown>): string {
  const list = ((cfg.agents as { list?: Array<{ id?: unknown; default?: unknown }> } | undefined)?.list ?? []).filter(
    (entry): entry is { id?: unknown; default?: unknown } => Boolean(entry && typeof entry === 'object'),
  );
  if (list.length === 0) return 'main';

  const defaults = list.filter((entry) => entry.default === true);
  const picked = defaults[0] ?? list[0];
  if (typeof picked?.id === 'string' && picked.id.trim()) {
    return picked.id.trim().toLowerCase();
  }
  return 'main';
}

async function ensureDynamicAgentListed(
  agentId: string,
  runtime: PluginRuntime,
  accountId: string,
): Promise<void> {
  const normalized = agentId.trim().toLowerCase();
  if (!normalized || ensuredDynamicAgentIds.has(normalized)) return;

  const configRuntime = runtime.config;
  if (!configRuntime?.loadConfig || !configRuntime?.writeConfigFile) {
    return;
  }

  ensureDynamicAgentWriteQueue = ensureDynamicAgentWriteQueue
    .then(async () => {
      if (ensuredDynamicAgentIds.has(normalized)) return;

      const latest = configRuntime.loadConfig() as ClawdbotConfig;
      if (!latest || typeof latest !== 'object') return;

      if (!canWriteFeishuConfig(latest, accountId)) {
        log.info(`dynamic agent list write skipped by configWrites policy: account=${accountId} agent=${agentId}`);
        return;
      }

      const changed = upsertDynamicAgentIntoList(latest as unknown as Record<string, unknown>, normalized);
      if (changed) {
        await Promise.resolve(configRuntime.writeConfigFile(latest));
        log.info(`dynamic agent listed: ${normalized}`);
      }

      ensuredDynamicAgentIds.add(normalized);
    })
    .catch((err) => {
      log.warn(`dynamic agent list write failed: agent=${agentId} error=${String(err)}`);
    });

  await ensureDynamicAgentWriteQueue;
}

/**
 * Ensure dynamic agent is present in `agents.list` (if config writes allow it).
 */
export async function ensureDynamicAgentListedForRuntime(params: {
  agentId: string;
  runtime: PluginRuntime;
  accountId: string;
}): Promise<void> {
  await ensureDynamicAgentListed(params.agentId, params.runtime, params.accountId);
}

// ---------------------------------------------------------------------------
// Workspace bootstrap + skills watch
// ---------------------------------------------------------------------------

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  if (override) return override;
  return path.join(os.homedir(), '.openclaw');
}

function resolveDynamicWorkspaceDir(agentId: string): string {
  return path.join(resolveStateDir(), `workspace-${agentId}`);
}

function resolveDynamicAgentDir(agentId: string): string {
  return path.join(resolveStateDir(), 'agents', agentId, 'agent');
}

function ensureDynamicAgentRuntimeDirs(agentId: string): void {
  try {
    fs.mkdirSync(resolveDynamicAgentDir(agentId), { recursive: true });
    fs.mkdirSync(resolveDynamicWorkspaceDir(agentId), { recursive: true });
  } catch (err) {
    log.error(`failed to ensure dynamic runtime dirs: agent=${agentId} error=${String(err)}`);
  }
}

function copyDirRecursive(src: string, dest: string): boolean {
  let hadError = false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (err) {
    log.error(`workspace seed read failed: src=${src} error=${String(err)}`);
    return true;
  }

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        hadError = copyDirRecursive(srcPath, destPath) || hadError;
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    } catch (err) {
      hadError = true;
      log.error(`workspace seed copy failed: ${srcPath} -> ${destPath} error=${String(err)}`);
    }
  }

  return hadError;
}

function resolveSourceWorkspaceCandidates(params: {
  cfg?: ClawdbotConfig;
  sourceAgentId: string;
  stateDir: string;
}): string[] {
  const candidates: string[] = [];

  const list = (params.cfg as Record<string, unknown> | undefined)?.agents as
    | { list?: Array<Record<string, unknown>> }
    | undefined;
  if (Array.isArray(list?.list)) {
    for (const entry of list.list) {
      if (!entry || typeof entry !== 'object') continue;
      if (String(entry.id ?? '') !== params.sourceAgentId) continue;
      if (typeof entry.workspace === 'string' && entry.workspace.trim()) {
        candidates.push(path.resolve(entry.workspace.replace(/^~/, os.homedir())));
      }
      break;
    }
  }

  candidates.push(path.join(params.stateDir, `workspace-${params.sourceAgentId}`));
  candidates.push(path.join(params.stateDir, 'workspace'));
  return candidates;
}

function recordDynamicSkillDelta(
  agentId: string,
  skillName: string,
  changeType: DynamicSkillDelta['changeType'],
  skillFilePath: string,
): void {
  const existing = dynamicSkillsDeltaState.get(agentId) ?? {
    changes: new Map<string, DynamicSkillDelta>(),
  };
  existing.changes.set(skillName, { skillName, changeType, skillFilePath });
  dynamicSkillsDeltaState.set(agentId, existing);
}

function noteDynamicSkillFileChange(agentId: string, skillDir: string): void {
  const skillName = path.basename(skillDir);
  const skillFilePath = path.join(skillDir, 'SKILL.md');
  const exists = fs.existsSync(skillFilePath);
  recordDynamicSkillDelta(agentId, skillName, exists ? 'updated' : 'removed', skillFilePath);
}

function watchSkillChildDir(agentId: string, childDir: string): void {
  let watchers = dynamicSkillsChildWatchers.get(agentId);
  if (!watchers) {
    watchers = new Map<string, fs.FSWatcher>();
    dynamicSkillsChildWatchers.set(agentId, watchers);
  }
  if (watchers.has(childDir) || !fs.existsSync(childDir)) return;

  try {
    const watcher = fs.watch(childDir, (_eventType, fileName) => {
      if (!fileName || String(fileName) === 'SKILL.md') {
        noteDynamicSkillFileChange(agentId, childDir);
      }
    });
    watcher.on('error', (err) => {
      log.warn(`skills child watcher error: agent=${agentId} dir=${childDir} error=${String(err)}`);
    });
    watchers.set(childDir, watcher);
  } catch (err) {
    log.warn(`skills child watch failed: agent=${agentId} dir=${childDir} error=${String(err)}`);
  }
}

function syncDynamicSkillsChildWatchers(agentId: string, skillsDir: string, includeAdds: boolean): void {
  const active = dynamicSkillsChildWatchers.get(agentId) ?? new Map<string, fs.FSWatcher>();
  const nextDirs = new Set<string>();

  if (fs.existsSync(skillsDir)) {
    try {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const childDir = path.join(skillsDir, entry.name);
        nextDirs.add(childDir);
        if (!active.has(childDir)) {
          watchSkillChildDir(agentId, childDir);
          const skillFilePath = path.join(childDir, 'SKILL.md');
          if (includeAdds && fs.existsSync(skillFilePath)) {
            recordDynamicSkillDelta(agentId, entry.name, 'added', skillFilePath);
          }
        }
      }
    } catch (err) {
      log.warn(`skills scan failed: agent=${agentId} dir=${skillsDir} error=${String(err)}`);
    }
  }

  for (const [childDir, watcher] of active) {
    if (nextDirs.has(childDir)) continue;
    watcher.close();
    active.delete(childDir);
    recordDynamicSkillDelta(agentId, path.basename(childDir), 'removed', path.join(childDir, 'SKILL.md'));
  }

  dynamicSkillsChildWatchers.set(agentId, active);
}

function ensureDynamicSkillsWatcher(agentId: string, workspaceDir: string): void {
  ensureDynamicAgentShutdownHookRegistered();

  const normalizedWorkspaceDir = path.resolve(workspaceDir);
  const existingWorkspaceDir = dynamicSkillsWorkspaceDirs.get(agentId);
  if (existingWorkspaceDir && existingWorkspaceDir !== normalizedWorkspaceDir) {
    dynamicSkillsRootWatchers.get(agentId)?.close();
    dynamicSkillsRootWatchers.delete(agentId);

    const childWatchers = dynamicSkillsChildWatchers.get(agentId);
    if (childWatchers) {
      for (const watcher of childWatchers.values()) watcher.close();
      dynamicSkillsChildWatchers.delete(agentId);
    }
  }

  dynamicSkillsWorkspaceDirs.set(agentId, normalizedWorkspaceDir);

  const skillsDir = path.join(normalizedWorkspaceDir, 'skills');
  if (!fs.existsSync(skillsDir)) return;

  if (!dynamicSkillsRootWatchers.has(agentId)) {
    try {
      const watcher = fs.watch(skillsDir, (_eventType, fileName) => {
        syncDynamicSkillsChildWatchers(agentId, skillsDir, true);
        if (!fileName || String(fileName) === 'SKILL.md') {
          recordDynamicSkillDelta(agentId, '(workspace-root)', 'updated', path.join(skillsDir, 'SKILL.md'));
        }
      });
      watcher.on('error', (err) => {
        log.warn(`skills root watcher error: agent=${agentId} dir=${skillsDir} error=${String(err)}`);
      });
      dynamicSkillsRootWatchers.set(agentId, watcher);
    } catch (err) {
      log.warn(`skills root watch failed: agent=${agentId} dir=${skillsDir} error=${String(err)}`);
      return;
    }
  }

  syncDynamicSkillsChildWatchers(agentId, skillsDir, false);
}

/**
 * Ensure dynamic workspace exists and is seeded from source workspace once.
 */
export function ensureDynamicWorkspaceSeeded(params: {
  dynamicAgentId: string;
  sourceAgentId: string;
  cfg?: ClawdbotConfig;
}): void {
  const stateDir = resolveStateDir();
  const targetWorkspace = path.join(stateDir, `workspace-${params.dynamicAgentId}`);
  const seedMarker = path.join(targetWorkspace, '.seeded');

  ensureDynamicAgentRuntimeDirs(params.dynamicAgentId);

  if (fs.existsSync(seedMarker)) {
    ensureDynamicSkillsWatcher(params.dynamicAgentId, targetWorkspace);
    return;
  }

  let seedFailed = false;
  let sourceWorkspace: string | undefined;
  const candidates = resolveSourceWorkspaceCandidates({
    cfg: params.cfg,
    sourceAgentId: params.sourceAgentId,
    stateDir,
  });

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      sourceWorkspace = candidate;
      break;
    }
  }

  if (!sourceWorkspace) {
    ensureDynamicSkillsWatcher(params.dynamicAgentId, targetWorkspace);
    return;
  }

  for (const file of DYNAMIC_WORKSPACE_STANDARD_FILES) {
    const src = path.join(sourceWorkspace, file);
    const dest = path.join(targetWorkspace, file);
    if (!fs.existsSync(src)) continue;
    try {
      fs.copyFileSync(src, dest);
    } catch (err) {
      seedFailed = true;
      log.error(`workspace seed copy file failed: ${src} -> ${dest} error=${String(err)}`);
    }
  }

  const skillsSrc = path.join(sourceWorkspace, 'skills');
  if (fs.existsSync(skillsSrc)) {
    const skillsDest = path.join(targetWorkspace, 'skills');
    try {
      fs.mkdirSync(skillsDest, { recursive: true });
      seedFailed = copyDirRecursive(skillsSrc, skillsDest) || seedFailed;
    } catch (err) {
      seedFailed = true;
      log.error(`workspace seed copy skills failed: ${skillsSrc} -> ${skillsDest} error=${String(err)}`);
    }
  }

  if (!seedFailed) {
    try {
      fs.writeFileSync(seedMarker, new Date().toISOString());
    } catch (err) {
      log.error(`workspace seed marker write failed: ${seedMarker} error=${String(err)}`);
    }
  }

  ensureDynamicSkillsWatcher(params.dynamicAgentId, targetWorkspace);
}

/**
 * Prepare filesystem/runtime side effects for a dynamic agent.
 */
export function bootstrapDynamicAgent(params: {
  cfg: ClawdbotConfig;
  dynamicAgentId: string;
  sourceAgentId: string;
}): void {
  const dynamic = getDynamicAgentConfig(params.cfg);
  if (dynamic.workspaceSeed) {
    ensureDynamicWorkspaceSeeded({
      dynamicAgentId: params.dynamicAgentId,
      sourceAgentId: params.sourceAgentId,
      cfg: params.cfg,
    });
    return;
  }
  ensureDynamicAgentRuntimeDirs(params.dynamicAgentId);
  ensureDynamicSkillsWatcher(params.dynamicAgentId, resolveDynamicWorkspaceDir(params.dynamicAgentId));
}

// ---------------------------------------------------------------------------
// Runtime note injection for changed skills
// ---------------------------------------------------------------------------

export function consumeDynamicSkillsDeltaNote(agentId: string): string | undefined {
  const state = dynamicSkillsDeltaState.get(agentId);
  if (!state || state.changes.size === 0) return undefined;

  const lines = [
    '[Runtime note: workspace skills changed]',
    'The following workspace skills changed recently. Any earlier conversation about them may be stale.',
  ];

  for (const change of state.changes.values()) {
    lines.push(`- ${change.changeType}: ${change.skillName} (${change.skillFilePath})`);
  }

  lines.push('If the current task may use one of these skills, re-read the listed SKILL.md before relying on it.');

  dynamicSkillsDeltaState.delete(agentId);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Cleanup / tests
// ---------------------------------------------------------------------------

function cleanupDynamicSkillsWatchers(): void {
  for (const watcher of dynamicSkillsRootWatchers.values()) watcher.close();
  dynamicSkillsRootWatchers.clear();

  for (const childWatchers of dynamicSkillsChildWatchers.values()) {
    for (const watcher of childWatchers.values()) watcher.close();
  }
  dynamicSkillsChildWatchers.clear();
  dynamicSkillsWorkspaceDirs.clear();
}

function ensureDynamicAgentShutdownHookRegistered(): void {
  if (dynamicAgentShutdownHookRegistered) return;
  registerShutdownHook('feishu-dynamic-agent-watchers', async () => {
    cleanupDynamicSkillsWatchers();
  });
  dynamicAgentShutdownHookRegistered = true;
}

/**
 * Test-only state reset.
 */
export function resetDynamicAgentStateForTests(): void {
  ensuredDynamicAgentIds.clear();
  ensureDynamicAgentWriteQueue = Promise.resolve();
  cleanupDynamicSkillsWatchers();
  dynamicSkillsDeltaState.clear();
}
