import type { Context } from '@deepseek-ai/cordis'
import { registerSettings } from './settings'
import { openDraftsDomain } from './storage'
import { registerStyleSection } from './section'
import { registerSubagents } from './subagents'
import { registerArticleTool } from './tools/article'
import { registerImageTool } from './tools/image'
import { registerListDraftsTool } from './tools/list-drafts'

export const name = 'wechat-article'

export const inject = [
  'subagents',
  'storageDomain',
  'settings',
  'systemPrompt',
  'tools',
] as const

/**
 * 把插件的各部分串起来。顺序很重要:
 *   1. settings  — 其它模块都要读当前的 style/tone。
 *   2. storage   — 工具往表里写草稿;打开 domain 是 async 的,
 *                  所以要先 await 再注册其它东西。
 *   3. section   — 注册风格提示词片段;在 sub-agents 之前或之后都行,
 *                  因为 section 是在 prompt 组装时才被读的。
 *   4. subagents — 注册 provider,让编排工具能找得到。
 *   5. tools     — 面向模型的工具;它们依赖上面所有内容。
 */
export async function apply(ctx: Context): Promise<void> {
  ctx.logger.info('[wechat-article] loading…')

  const scope = registerSettings(ctx)
  const drafts = await openDraftsDomain(ctx)
  registerStyleSection(ctx, scope)
  registerSubagents(ctx)
  registerArticleTool(ctx, scope, drafts)
  registerImageTool(ctx)
  registerListDraftsTool(ctx, drafts)

  ctx.logger.info(
    '[wechat-article] ready: providers=wechat-outline,wechat-draft,wechat-polish,wechat-title,wechat-cover '
    + 'tools=wechat-article,wechat-image,wechat-list-drafts',
  )
}
