/**
 * `image-gen` 命名空间的 settings schema。
 *
 * 设计要点:
 * 1. 三个 provider 各自一份 enabled / apiKey / baseUrl / model,互不耦合;
 * 2. Bailian 是异步协议,多一个 `editModel`(I2I 走不同模型)+ `pollTimeoutMs`;
 * 3. schemastery@3.18.1 不暴露 .int(),数值字段只用 .min/.max 约束范围;
 * 4. 默认 baseUrl 给的是官方地址,改填自部署网关即可,无需手填路径。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ImageMediaType, ProviderId } from './types'

export const IMAGE_GEN_NAMESPACE = 'image-gen'

export interface ProviderConfig {
  enabled: boolean
  apiKey: string
  baseUrl: string
  model: string
}

export interface ImageGenSettings {
  defaultProvider: ProviderId
  defaultSize: string
  defaultN: number
  /** Bailian 异步任务轮询总超时(毫秒)。 */
  pollTimeoutMs: number
  /** Bailian I2I 专用模型,默认 wanx2.1-imageedit。 */
  bailianEditModel: string
  providers: {
    openai: ProviderConfig
    bailian: ProviderConfig
    minimax: ProviderConfig
  }
}

const PROVIDER_KEYS = ['openai', 'bailian', 'minimax'] as const

const Schema = z.object({
  defaultProvider: z.union([...PROVIDER_KEYS] as const).default('openai'),
  defaultSize: z.string().default('1024x1024'),
  defaultN: z.number().min(1).max(9).default(1),
  pollTimeoutMs: z.number().min(10000).max(600000).default(180000),
  bailianEditModel: z.string().default('wanx2.1-imageedit'),
  providers: z.object({
    openai: z.object({
      enabled: z.boolean().default(false),
      apiKey: z.string().default(''),
      baseUrl: z.string().default('https://api.openai.com'),
      model: z.string().default('gpt-image-1'),
    }),
    bailian: z.object({
      enabled: z.boolean().default(false),
      apiKey: z.string().default(''),
      baseUrl: z.string().default('https://dashscope.aliyuncs.com'),
      model: z.string().default('wanx-v1'),
    }),
    minimax: z.object({
      enabled: z.boolean().default(false),
      apiKey: z.string().default(''),
      baseUrl: z.string().default('https://api.minimaxi.com'),
      model: z.string().default('image-01'),
    }),
  }),
})

const BASE: ImageGenSettings = {
  defaultProvider: 'minimax',
  defaultSize: '1024x1024',
  defaultN: 1,
  pollTimeoutMs: 180000,
  bailianEditModel: 'wanx2.1-imageedit',
  providers: {
    openai: { enabled: false, apiKey: '', baseUrl: 'https://api.openai.com', model: 'gpt-image-1' },
    bailian: { enabled: false, apiKey: '', baseUrl: 'https://dashscope.aliyuncs.com', model: 'wanx-v1' },
    minimax: { enabled: false, apiKey: '', baseUrl: 'https://api.minimaxi.com/v1', model: 'image-01' },
  },
}

/**
 * 暴露给 `config-file.ts` 合并默认值用。Base 形如 UI 的 "base" 层,
 * 用户 JSON 文件的 patch 会以 user 层覆盖之。
 */
export const IMAGE_GEN_BASE = BASE

export function registerSettings(ctx: Context): SettingsScope<ImageGenSettings> {
  return ctx.settings.register(settingsNamespace(IMAGE_GEN_NAMESPACE), Schema, { base: BASE })
}

/** 把 "1024x1024" / "1024*1024" / 16:9 三种写法归一化成 PNG-friendly 像素串。 */
export function normalizeSizeForProvider(provider: ProviderId, size: string): string {
  // Bailian 用 '*' 分隔,其他用 'x';按需转换。
  if (provider === 'bailian') {
    return size.replace(/x/g, '*')
  }
  return size.replace(/\*/g, 'x')
}

/** 由 media type 推出文件扩展名,落盘时用。 */
export function mediaTypeToExt(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
  }
}
