/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * OpenClaw Lark/Feishu plugin entry point.
 *
 * Registers the Feishu channel and all tool families:
 * doc, wiki, drive, perm, bitable, task, calendar.
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { emptyPluginConfigSchema } from 'openclaw/plugin-sdk';
import { feishuPlugin } from './channel/plugin';
import { LarkClient } from './core/lark-client';
import { registerOapiTools } from './tools/oapi/index';
import { registerFeishuMcpDocTools } from './tools/mcp/doc/index';
import { registerFeishuOAuthTool } from './tools/oauth';
import { registerFeishuOAuthBatchAuthTool } from './tools/oauth-batch-auth';
import { registerAskUserQuestionTool } from './tools/ask-user-question';
import {
  analyzeTrace,
  formatDiagReportCli,
  formatTraceOutput,
  runDiagnosis,
  traceByMessageId,
} from './commands/diagnose';
import { registerCommands } from './commands/index';
import { larkLogger } from './core/lark-logger';
import { emitSecurityWarnings } from './core/security-check';
import { recordToolUseEnd, recordToolUseStart } from './card/tool-use-trace-store';
import { sanitizeParamsForLog } from './card/reasoning-utils';

const log = larkLogger('plugin');

export async function monitorFeishuProvider(opts?: unknown) {
  const mod = await import('./channel/monitor');
  return mod.monitorFeishuProvider(opts as never);
}
export { sendMessageFeishu, sendCardFeishu, updateCardFeishu, editMessageFeishu } from './messaging/outbound/send';
export { getMessageFeishu } from './messaging/outbound/fetch';
export {
  uploadImageLark,
  uploadFileLark,
  sendImageLark,
  sendFileLark,
  sendAudioLark,
  uploadAndSendMediaLark,
} from './messaging/outbound/media';
export {
  sendTextLark,
  sendCardLark,
  sendMediaLark,
  type SendTextLarkParams,
  type SendCardLarkParams,
  type SendMediaLarkParams,
} from './messaging/outbound/deliver';
export { type FeishuChannelData } from './messaging/outbound/outbound';
export { probeFeishu } from './channel/probe';
export {
  addReactionFeishu,
  removeReactionFeishu,
  listReactionsFeishu,
  FeishuEmoji,
  VALID_FEISHU_EMOJI_TYPES,
} from './messaging/outbound/reactions';
export { forwardMessageFeishu } from './messaging/outbound/forward';
export {
  updateChatFeishu,
  addChatMembersFeishu,
  removeChatMembersFeishu,
  listChatMembersFeishu,
} from './messaging/outbound/chat-manage';
export { feishuMessageActions } from './messaging/outbound/actions';
export {
  mentionedBot,
  nonBotMentions,
  extractMessageBody,
  formatMentionForText,
  formatMentionForCard,
  formatMentionAllForText,
  formatMentionAllForCard,
  buildMentionedMessage,
  buildMentionedCardContent,
  type MentionInfo,
} from './messaging/inbound/mention';
export { feishuPlugin } from './channel/plugin';
export type {
  MessageContext,
  RawMessage,
  RawSender,
  FeishuMessageContext,
  FeishuReactionCreatedEvent,
} from './messaging/types';
export { handleFeishuReaction } from './messaging/inbound/reaction-handler';
export { parseMessageEvent } from './messaging/inbound/parse';
export { checkMessageGate } from './messaging/inbound/gate';
export { isMessageExpired } from './messaging/inbound/dedup';

const plugin = {
  id: 'openclaw-lark',
  name: 'Feishu',
  description: 'Lark/Feishu channel plugin with im/doc/wiki/drive/task/calendar tools',
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi): void {
    LarkClient.setRuntime(api.runtime);
    api.registerChannel({ plugin: feishuPlugin });

    registerOapiTools(api);
    registerFeishuMcpDocTools(api);
    registerFeishuOAuthTool(api);
    registerFeishuOAuthBatchAuthTool(api);
    registerAskUserQuestionTool(api);

    api.on('before_tool_call', (event, ctx) => {
      recordToolUseStart({
        sessionKey: ctx.sessionKey,
        toolName: event.toolName,
        toolParams: event.params,
        toolCallId: event.toolCallId ?? ctx.toolCallId,
        runId: event.runId ?? ctx.runId,
      });
      if (!event.toolName.startsWith('feishu_')) return;
      const paramsPreview = sanitizeParamsForLog(event.params);
      log.info(`tool call: ${event.toolName} session=${ctx.sessionKey ?? '-'} params=${paramsPreview}`);
    });

    api.on('after_tool_call', (event, ctx) => {
      recordToolUseEnd({
        sessionKey: ctx.sessionKey,
        toolName: event.toolName,
        toolParams: event.params,
        toolCallId: event.toolCallId ?? ctx.toolCallId,
        runId: event.runId ?? ctx.runId,
        result: event.result,
        error: event.error,
        durationMs: event.durationMs,
      });
      if (!event.toolName.startsWith('feishu_')) return;
      if (event.error) {
        log.error(
          `tool fail: ${event.toolName} session=${ctx.sessionKey ?? '-'} ${event.error} (${event.durationMs ?? 0}ms)`,
        );
      } else {
        log.info(`tool done: ${event.toolName} session=${ctx.sessionKey ?? '-'} ok (${event.durationMs ?? 0}ms)`);
      }
    });

    api.registerCli(
      (ctx) => {
        ctx.program
          .command('feishu-diagnose')
          .description('运行飞书插件诊断，检查配置、连通性和权限状态')
          .option('--trace <messageId>', '按 message_id 追踪完整处理链路')
          .option('--analyze', '分析追踪日志（需配合 --trace 使用）')
          .action(async (opts: { trace?: string; analyze?: boolean }) => {
            try {
              if (opts.trace) {
                const lines = await traceByMessageId(opts.trace);
                console.log(formatTraceOutput(lines, opts.trace));
                if (opts.analyze && lines.length > 0) {
                  console.log(analyzeTrace(lines, opts.trace));
                }
              } else {
                const report = await runDiagnosis({
                  config: ctx.config,
                  logger: ctx.logger,
                });
                console.log(formatDiagReportCli(report));
                if (report.overallStatus === 'unhealthy') {
                  process.exitCode = 1;
                }
              }
            } catch (err) {
              ctx.logger.error(`诊断命令执行失败: ${err}`);
              process.exitCode = 1;
            }
          });
      },
      { commands: ['feishu-diagnose'] },
    );

    registerCommands(api);

    if (api.config) {
      emitSecurityWarnings(api.config, api.logger);
    }
  },
};

export default plugin;
