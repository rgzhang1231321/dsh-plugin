import type { Context } from '@deepseek-ai/cordis'
import { WechatSubagentProvider } from './provider'
import {
  COVER_PERSONA,
  DRAFT_PERSONA,
  INLINE_IMAGE_PERSONA,
  OUTLINE_PERSONA,
  POLISH_PERSONA,
  TITLE_PERSONA,
} from '../personas'


export function registerSubagents(ctx: Context): void {
  const providers = [
    { name: 'wechat-outline', persona: OUTLINE_PERSONA },
    { name: 'wechat-draft', persona: DRAFT_PERSONA },
    { name: 'wechat-polish', persona: POLISH_PERSONA },
    { name: 'wechat-title', persona: TITLE_PERSONA },
    { name: 'wechat-cover', persona: COVER_PERSONA },
    { name: 'wechat-inline-images', persona: INLINE_IMAGE_PERSONA },
  ] as const

  for (const { name, persona } of providers) {
    ctx.subagents.registerProvider(new WechatSubagentProvider(name, persona))
  }
}
