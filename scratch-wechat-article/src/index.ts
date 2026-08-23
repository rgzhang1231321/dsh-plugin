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
