/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * Agent dispatch for inbound Feishu messages.
 *
 * Builds the agent envelope, prepends chat history context, and
 * dispatches through the appropriate reply path (system command
 * vs. normal streaming/static flow).
 *
 * Implementation details are split across focused modules:
 * - dispatch-context.ts  — DispatchContext type, route/session/event
 * - dispatch-builders.ts — pure payload/body/envelope construction
 * - dispatch-commands.ts — system command & permission notification
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { ClawdbotConfig, RuntimeEnv  } from 'openclaw/plugin-sdk';
import { resolveAgentWorkspaceDir } from 'openclaw/plugin-sdk/agent-runtime';
import type { HistoryEntry } from 'openclaw/plugin-sdk/reply-history';
import { clearHistoryEntriesIfEnabled } from 'openclaw/plugin-sdk/reply-history';
import type { MessageContext } from '../types';
import type { FeishuGroupConfig, LarkAccount  } from '../../core/types';
import { larkLogger } from '../../core/lark-logger';
import { ticketElapsed } from '../../core/lark-ticket';
import { createFeishuReplyDispatcher } from '../../card/reply-dispatcher';
import {
  buildQueueKey,
  registerActiveDispatcher,
  threadScopedKey,
  unregisterActiveDispatcher,
} from '../../channel/chat-queue';
import { resolveToolUseDisplayConfig } from '../../card/tool-use-config';
import { clearToolUseTraceRun, startToolUseTraceRun } from '../../card/tool-use-trace-store';
import { isLikelyAbortText } from '../../channel/abort-detect';
import { isThreadCapableGroup } from '../../core/chat-info-cache';
import { encodeFeishuRouteTarget } from '../../core/targets';
import type { LarkClient } from '../../core/lark-client';
import { runFeishuDoctorI18n } from '../../commands/doctor';
import { runFeishuAuthI18n } from '../../commands/auth';
import { getFeishuHelpI18n, runFeishuStartI18n } from '../../commands/index';
import { buildI18nMarkdownCard, sendCardFeishu, sendMessageFeishu } from '../outbound/send';
import { dispatchPermissionNotification, dispatchSystemCommand } from './dispatch-commands';
import {
  buildBodyForAgent,
  buildEnvelopeWithHistory,
  buildInboundPayload,
  buildMessageBody,
} from './dispatch-builders';
import { type DispatchContext, buildDispatchContext, resolveThreadSessionKey } from './dispatch-context';
import type { PermissionError } from './permission';
import { mentionedBot } from './mention';
import { resolveRespondToMentionAll } from './gate';
import { consumeDynamicSkillsDeltaNote } from './dynamic-agent';

const log = larkLogger('inbound/dispatch');

// ---------------------------------------------------------------------------
// Internal: media workspace mirror (non-core workaround for >5MB sandbox staging)
// ---------------------------------------------------------------------------

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
}

function extractMediaPaths(mediaPayload: Record<string, unknown>): string[] {
  const fromArray = toStringArray(mediaPayload.MediaPaths);
  if (fromArray.length > 0) return fromArray;
  const single = typeof mediaPayload.MediaPath === 'string' ? mediaPayload.MediaPath.trim() : '';
  return single ? [single] : [];
}

function sanitizeWorkspaceFileName(input: string): string {
  const blocked = '<>:"/\\|?*';
  let out = '';
  for (const ch of path.basename(input || '')) {
    const code = ch.charCodeAt(0);
    out += code < 32 || blocked.includes(ch) ? '_' : ch;
  }
  const base = out.trim();
  return base || 'attachment.bin';
}

async function resolveUniquePath(dir: string, fileName: string): Promise<string> {
  const parsed = path.parse(fileName);
  let candidate = path.join(dir, fileName);
  let index = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${parsed.name}-${index}${parsed.ext}`);
      index += 1;
    } catch {
      return candidate;
    }
  }
}

async function mirrorInboundMediaToAgentWorkspace(params: {
  ctx: MessageContext;
  mediaPayload: Record<string, unknown>;
  accountScopedCfg: ClawdbotConfig;
  agentId: string;
  accountId: string;
  log: (...args: unknown[]) => void;
}): Promise<{ ctx: MessageContext; mediaPayload: Record<string, unknown> }> {
  const srcPaths = extractMediaPaths(params.mediaPayload);
  if (srcPaths.length === 0) {
    return { ctx: params.ctx, mediaPayload: params.mediaPayload };
  }

  const workspaceDir = resolveAgentWorkspaceDir(params.accountScopedCfg, params.agentId);
  if (!workspaceDir || !workspaceDir.trim()) {
    return { ctx: params.ctx, mediaPayload: params.mediaPayload };
  }

  const inboundDir = path.join(workspaceDir, 'media', 'inbound');
  await fs.mkdir(inboundDir, { recursive: true });

  const rewriteMap = new Map<string, string>();
  for (const src of srcPaths) {
    const absSrc = path.resolve(src);
    if (rewriteMap.has(src) || rewriteMap.has(absSrc)) continue;

    let stat;
    try {
      stat = await fs.stat(absSrc);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const targetName = sanitizeWorkspaceFileName(path.basename(absSrc));
    const dest = await resolveUniquePath(inboundDir, targetName);
    try {
      await fs.copyFile(absSrc, dest);
      rewriteMap.set(src, dest);
      rewriteMap.set(absSrc, dest);
    } catch (err) {
      params.log(
        `feishu[${params.accountId}]: failed to mirror media to workspace: ${absSrc} -> ${dest}, error=${String(err)}`,
      );
    }
  }

  if (rewriteMap.size === 0) {
    return { ctx: params.ctx, mediaPayload: params.mediaPayload };
  }

  const rewritePath = (raw: unknown): string | undefined => {
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    return rewriteMap.get(trimmed) ?? rewriteMap.get(path.resolve(trimmed)) ?? trimmed;
  };

  const nextPaths = srcPaths.map((raw) => rewritePath(raw) ?? raw);
  const nextFirstPath = nextPaths[0];

  let nextContent = params.ctx.content;
  for (const [from, to] of rewriteMap.entries()) {
    if (from !== to) {
      nextContent = nextContent.split(from).join(to);
    }
  }

  const nextMediaPayload: Record<string, unknown> = { ...params.mediaPayload };
  if (nextPaths.length > 0) {
    nextMediaPayload.MediaPaths = nextPaths;
    nextMediaPayload.MediaUrls = nextPaths;
    nextMediaPayload.MediaPath = nextFirstPath;
    nextMediaPayload.MediaUrl = nextFirstPath;
  }

  params.log(
    `feishu[${params.accountId}]: mirrored ${nextPaths.length} media file(s) into agent workspace: ${inboundDir}`,
  );

  return {
    ctx: {
      ...params.ctx,
      content: nextContent,
    },
    mediaPayload: nextMediaPayload,
  };
}

// ---------------------------------------------------------------------------
// Internal: normal message dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a normal (non-command) message via the streaming card flow.
 * Cleans up consumed history entries after dispatch completes.
 *
 * Note: history cleanup is intentionally placed here and NOT in the
 * system-command path — command handlers don't consume history context,
 * so the entries should be preserved for the next normal message.
 */
async function dispatchNormalMessage(
  dc: DispatchContext,
  ctxPayload: ReturnType<typeof LarkClient.runtime.channel.reply.finalizeInboundContext>,
  chatHistories: Map<string, HistoryEntry[]> | undefined,
  historyKey: string | undefined,
  historyLimit: number,
  replyToMessageId?: string,
  skillFilter?: string[],
  skipTyping?: boolean,
): Promise<void> {
  // Abort messages should never create streaming cards — dispatch via the
  // plain-text system-command path so the SDK's abort handler can reply
  // without touching CardKit.
  if (isLikelyAbortText(dc.ctx.content?.trim() ?? '')) {
    dc.log(`feishu[${dc.account.accountId}]: abort message detected, using plain-text dispatch`);
    log.info('abort message detected, using plain-text dispatch');
    await dispatchSystemCommand(dc, ctxPayload, replyToMessageId);
    return;
  }

  const effectiveSessionKey = dc.threadSessionKey ?? dc.route.sessionKey;
  const toolUseDisplay = resolveToolUseDisplayConfig({
    cfg: dc.accountScopedCfg,
    feishuCfg: dc.account.config,
    agentId: dc.route.agentId,
    sessionKey: effectiveSessionKey,
    body: dc.ctx.content,
  });
  if (toolUseDisplay.showToolUse) {
    startToolUseTraceRun(effectiveSessionKey);
  } else {
    clearToolUseTraceRun(effectiveSessionKey);
  }

  const { dispatcher, replyOptions, markDispatchIdle, markFullyComplete, abortCard } = createFeishuReplyDispatcher({
    cfg: dc.accountScopedCfg,
    agentId: dc.route.agentId,
    chatId: dc.ctx.chatId,
    sessionKey: effectiveSessionKey,
    replyToMessageId: replyToMessageId ?? dc.ctx.messageId,
    accountId: dc.account.accountId,
    chatType: dc.ctx.chatType,
    skipTyping,
    replyInThread: dc.isThread,
    toolUseDisplay,
  });

  // Create an AbortController so the abort fast-path can cancel the
  // underlying LLM request (not just the streaming card UI).
  const abortController = new AbortController();

  // Register the active dispatcher so the monitor abort fast-path can
  // terminate the streaming card before this task completes.
  const queueKey = buildQueueKey(dc.account.accountId, dc.ctx.chatId, dc.ctx.threadId);
  registerActiveDispatcher(queueKey, { abortCard, abortController });

  dc.log(`feishu[${dc.account.accountId}]: dispatching to agent (session=${effectiveSessionKey})`);
  log.info(`dispatching to agent (session=${effectiveSessionKey})`);

  try {
    const { queuedFinal, counts } = await dc.core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg: dc.accountScopedCfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        abortSignal: abortController.signal,
        ...(skillFilter ? { skillFilter } : {}),
      },
    });

    // Wait for all enqueued deliver() calls in the SDK's sendChain to
    // complete before marking the dispatch as done.  Without this,
    // dispatchReplyFromConfig() may return while the final deliver() is
    // still pending in the Promise chain, causing markFullyComplete() to
    // block it and leaving completedText incomplete — which in turn makes
    // the streaming card's final update show truncated content.
    await dispatcher.waitForIdle();

    markFullyComplete();
    markDispatchIdle();

    // Clean up consumed history entries
    if (dc.isGroup && historyKey && chatHistories) {
      clearHistoryEntriesIfEnabled({
        historyMap: chatHistories,
        historyKey,
        limit: historyLimit,
      });
    }

    dc.log(`feishu[${dc.account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`);
    log.info(`dispatch complete (replies=${counts.final}, elapsed=${ticketElapsed()}ms)`);
  } finally {
    unregisterActiveDispatcher(queueKey);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function dispatchToAgent(params: {
  ctx: MessageContext;
  permissionError?: PermissionError;
  mediaPayload: Record<string, unknown>;
  quotedContent?: string;
  account: LarkAccount;
  /** account 级别的 ClawdbotConfig（channels.feishu 已替换为 per-account 合并后的配置） */
  accountScopedCfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  chatHistories?: Map<string, HistoryEntry[]>;
  historyLimit: number;
  /** Override the message ID used for reply threading.  When set, the
   *  reply-dispatcher uses this ID for typing indicators and card replies
   *  instead of ctx.messageId (which may be a synthetic ID). */
  replyToMessageId?: string;
  /** When set, controls whether the sender is authorized to execute
   *  control commands.  Computed by the handler via the SDK's access
   *  group command gating system. */
  commandAuthorized?: boolean;
  /** Per-group configuration for skills, systemPrompt, etc. */
  groupConfig?: FeishuGroupConfig;
  /** Default group configuration from the "*" wildcard entry. */
  defaultGroupConfig?: FeishuGroupConfig;
  /** When true, the reply dispatcher skips typing indicators. */
  skipTyping?: boolean;
}): Promise<void> {
  // 1. Derive shared context (including route resolution + system event)
  const dc = buildDispatchContext(params);

  const mirrored = await mirrorInboundMediaToAgentWorkspace({
    ctx: params.ctx,
    mediaPayload: params.mediaPayload,
    accountScopedCfg: params.accountScopedCfg,
    agentId: dc.route.agentId,
    accountId: dc.account.accountId,
    log: dc.log,
  });
  const inboundCtx = mirrored.ctx;
  const mediaPayload = mirrored.mediaPayload;

  // 1a. Thread detection fallback for topic groups.
  //     In topic groups (chat_mode=topic), reply events may carry root_id
  //     without thread_id.  When threadSession is enabled, use root_id as
  //     a synthetic threadId so replies stay inside the topic instead of
  //     creating a new top-level message.
  if (!dc.isThread && dc.isGroup && dc.ctx.rootId && dc.account.config?.threadSession === true) {
    const threadCapable = await isThreadCapableGroup({
      cfg: dc.accountScopedCfg,
      chatId: dc.ctx.chatId,
      accountId: dc.account.accountId,
    });
    if (threadCapable) {
      log.info(`inferred thread from root_id=${dc.ctx.rootId} in topic group ${dc.ctx.chatId}`);
      dc.isThread = true;
      dc.ctx = { ...dc.ctx, threadId: dc.ctx.rootId };
    }
  }

  // 1b. Resolve thread session isolation (async: may query group info API)
  if (dc.isThread && dc.ctx.threadId) {
    dc.threadSessionKey = await resolveThreadSessionKey({
      accountScopedCfg: dc.accountScopedCfg,
      account: dc.account,
      chatId: dc.ctx.chatId,
      threadId: dc.ctx.threadId,
      baseSessionKey: dc.route.sessionKey,
    });
  }

  // 2. Build annotated message body
  const messageBody = buildMessageBody(inboundCtx, params.quotedContent);

  // 3. Permission-error notification (optional side-effect).
  //    Isolated so a failure here does not block the main message dispatch.
  if (params.permissionError) {
    try {
      await dispatchPermissionNotification(dc, params.permissionError, params.replyToMessageId);
    } catch (err) {
      dc.error(`feishu[${dc.account.accountId}]: permission notification failed, continuing: ${String(err)}`);
    }
  }

  // 4. Build main envelope (with group chat history)
  const { combinedBody, historyKey } = buildEnvelopeWithHistory(
    dc,
    messageBody,
    params.chatHistories,
    params.historyLimit,
  );

  // 5. Build BodyForAgent with mention annotation (if any).
  //    SDK >= 2026.2.10 no longer falls back to Body for BodyForAgent,
  //    so we must set it explicitly to preserve the annotation.
  const bodyForAgent = buildBodyForAgent(inboundCtx);

  // 6. Build InboundHistory for SDK metadata injection (>= 2026.2.10).
  //    The SDK's buildInboundUserContextPrefix renders these as structured
  //    JSON blocks; earlier SDK versions simply ignore unknown fields.
  const threadHistoryKey = threadScopedKey(dc.ctx.chatId, dc.isThread ? dc.ctx.threadId : undefined);
  const inboundHistory =
    dc.isGroup && params.chatHistories && params.historyLimit > 0
      ? (params.chatHistories.get(threadHistoryKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp ?? Date.now(),
        }))
      : undefined;

  // 7. Precompute command text and command routing mode
  const contentTrimmed = (inboundCtx.content ?? '').trim();
  const isCommand = dc.core.channel.commands.isControlCommandMessage(inboundCtx.content, params.accountScopedCfg);

  // 8a. Intercept /feishu commands for i18n multi-locale card dispatch
  //     Must run BEFORE the SDK command check — the SDK does not recognise
  //     plugin-registered commands via isControlCommandMessage, so
  //     /feishu_* falls through to the AI agent otherwise.
  const isDoctorCommand = /^\/feishu[_ ]doctor\s*$/i.test(contentTrimmed);
  const isAuthCommand = /^\/feishu[_ ](?:auth|onboarding)\s*$/i.test(contentTrimmed);
  const isStartCommand = /^\/feishu[_ ]start\s*$/i.test(contentTrimmed);
  const isHelpCommand = /^\/feishu(?:[_ ]help)?\s*$/i.test(contentTrimmed);

  const i18nCommandName = isDoctorCommand
    ? 'doctor'
    : isAuthCommand
      ? 'auth'
      : isStartCommand
        ? 'start'
        : isHelpCommand
          ? 'help'
          : null;

  if (i18nCommandName) {
    dc.log(`feishu[${dc.account.accountId}]: ${i18nCommandName} command detected, using i18n dispatch`);
    log.info(`${i18nCommandName} command detected, using i18n dispatch`);
    try {
      let i18nTexts: Record<string, string>;
      if (isDoctorCommand) {
        i18nTexts = await runFeishuDoctorI18n(dc.accountScopedCfg, dc.account.accountId);
      } else if (isAuthCommand) {
        i18nTexts = await runFeishuAuthI18n(dc.accountScopedCfg);
      } else if (isStartCommand) {
        i18nTexts = runFeishuStartI18n(dc.accountScopedCfg);
      } else {
        i18nTexts = getFeishuHelpI18n();
      }
      const card = buildI18nMarkdownCard(i18nTexts);
      await sendCardFeishu({
        cfg: dc.accountScopedCfg,
        to: dc.ctx.chatId,
        card,
        replyToMessageId: params.replyToMessageId ?? dc.ctx.messageId,
        accountId: dc.account.accountId,
        replyInThread: dc.isThread,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      dc.error(`feishu[${dc.account.accountId}]: ${i18nCommandName} i18n dispatch failed: ${errMsg}`);
      await sendMessageFeishu({
        cfg: dc.accountScopedCfg,
        to: dc.ctx.chatId,
        text: `${i18nCommandName} failed: ${errMsg}`,
        replyToMessageId: params.replyToMessageId ?? dc.ctx.messageId,
        accountId: dc.account.accountId,
        replyInThread: dc.isThread,
      });
    }
    return;
  }

  // 9. Build inbound context payload
  const isBareNewOrReset = /^\/(?:new|reset)\s*$/i.test((inboundCtx.content ?? '').trim());
  const groupSystemPrompt = dc.isGroup
    ? params.groupConfig?.systemPrompt?.trim() || params.defaultGroupConfig?.systemPrompt?.trim() || undefined
    : undefined;
  const originatingTo =
    isBareNewOrReset && dc.isThread
      ? encodeFeishuRouteTarget({
          target: dc.feishuTo,
          replyToMessageId: params.replyToMessageId ?? params.ctx.messageId,
          threadId: dc.ctx.threadId,
        })
      : undefined;
  let finalBodyForAgent = bodyForAgent;
  if (!isCommand) {
    const skillsNote = consumeDynamicSkillsDeltaNote(dc.route.agentId);
    if (skillsNote) {
      finalBodyForAgent = `${skillsNote}\n\n${bodyForAgent}`;
      dc.log(`feishu[${dc.account.accountId}]: dynamic skills runtime note injected (agent=${dc.route.agentId})`);
    }
  }
  const ctxPayload = buildInboundPayload(dc, {
    body: combinedBody,
    bodyForAgent: finalBodyForAgent,
    rawBody: inboundCtx.content,
    commandBody: inboundCtx.content,
    originatingTo,
    senderName: inboundCtx.senderName ?? inboundCtx.senderId,
    senderId: inboundCtx.senderId,
    messageSid: inboundCtx.messageId,
    wasMentioned:
      mentionedBot(inboundCtx) ||
      (inboundCtx.mentionAll &&
        resolveRespondToMentionAll({
          groupConfig: params.groupConfig,
          defaultConfig: params.defaultGroupConfig,
          accountFeishuCfg: params.account.config,
        })),
    replyToBody: params.quotedContent,
    inboundHistory,
    extraFields: {
      ...mediaPayload,
      ...(groupSystemPrompt ? { GroupSystemPrompt: groupSystemPrompt } : {}),
      ...(dc.ctx.threadId ? { MessageThreadId: dc.ctx.threadId } : {}),
    },
  });

  // 10. Dispatch: system command vs. normal message

  // Resolve per-group skill filter (per-group > default "*")
  const skillFilter = dc.isGroup ? (params.groupConfig?.skills ?? params.defaultGroupConfig?.skills) : undefined;

  if (isCommand) {
    await dispatchSystemCommand(dc, ctxPayload, params.replyToMessageId);
    // /new and /reset explicitly start a new session — clear pending history
    if (isBareNewOrReset && dc.isGroup && historyKey && params.chatHistories) {
      clearHistoryEntriesIfEnabled({
        historyMap: params.chatHistories,
        historyKey,
        limit: params.historyLimit,
      });
    }
  } else {
    // Normal message dispatch; history cleanup happens inside.
    // System commands intentionally skip history cleanup — command handlers
    // don't consume history context, so entries are preserved for the next
    // normal message.
    await dispatchNormalMessage(
      dc,
      ctxPayload,
      params.chatHistories,
      historyKey,
      params.historyLimit,
      params.replyToMessageId,
      skillFilter,
      params.skipTyping,
    );
  }
}
