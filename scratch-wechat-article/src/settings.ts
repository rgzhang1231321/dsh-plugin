import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'

export type Style = 'deep-analysis' | 'storytelling' | 'opinion'
export type Tone = 'warm' | 'professional' | 'casual'

export interface WechatSettings {
  style: Style
  targetLength: number
  tone: Tone
  model: string
  imageWidth: number
  imageHeight: number
  
  imageCount: number
}

const Schema = z.object({
  style: z
    .union(['deep-analysis', 'storytelling', 'opinion'])
    .default('deep-analysis'),
  targetLength: z.number().min(500).max(10000).default(2000),
  tone: z
    .union(['warm', 'professional', 'casual'])
    .default('warm'),
  model: z.string().default('deepseek-chat'),
  imageWidth: z.number().min(64).max(2048).default(1024),
  imageHeight: z.number().min(64).max(2048).default(1024),
  imageCount: z.number().min(1).max(6).default(3),
})

export const WECHAT_NAMESPACE = settingsNamespace('wechat-article')

const BASE: WechatSettings = {
  style: 'deep-analysis',
  targetLength: 2000,
  tone: 'warm',
  model: 'deepseek-chat',
  imageWidth: 1024,
  imageHeight: 1024,
  imageCount: 3,
}

export function registerSettings(ctx: Context): SettingsScope<WechatSettings> {
  return ctx.settings.register(WECHAT_NAMESPACE, Schema, { base: BASE })
}
