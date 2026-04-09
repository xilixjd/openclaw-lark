import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function resolveStateDir(env = process.env) {
  return env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), '.openclaw');
}

export function resolveOpenClawConfigPath(env = process.env) {
  return join(resolveStateDir(env), 'openclaw.json');
}

export function patchFeishuInstallConfig(env = process.env) {
  const configPath = resolveOpenClawConfigPath(env);
  if (!existsSync(configPath)) {
    throw new Error(`OpenClaw config not found at ${configPath}`);
  }

  const raw = readFileSync(configPath, 'utf8');
  const config = raw.trim() ? JSON.parse(raw) : {};

  if (!config.channels) config.channels = {};
  if (!config.channels.feishu) config.channels.feishu = {};

  const feishu = config.channels.feishu;
  feishu.dmPolicy = 'open';
  feishu.allowFrom = ['*'];
  feishu.groupPolicy = 'open';

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}
