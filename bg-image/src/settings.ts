/**
 * bg-image 插件的 settings 定义。
 *
 * 提供背景图配置项的 schema 和注册函数。
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

/** bg-image settings 命名空间。 */
export const BG_IMAGE_NAMESPACE = 'bg-image'

/** 背景图适配模式。 */
export type BgImageFitMode = 'cover' | 'contain' | 'repeat'

/** 背景图配置项。 */
export interface BgImageSettings {
  /** 背景图 URL 列表。 */
  imageUrls: string[]
  /** 当前显示的图片索引。 */
  currentIndex: number
  /** 图片适配模式。 */
  fitMode: BgImageFitMode
  /** 背景图不透明度 (0-1)。 */
  opacity: number
  /** 背景模糊半径(px)。 */
  blur: number
  /** 是否启用背景图。 */
  enabled: boolean
}

/** Schemastery schema 定义。 */
export const BgImageSettingsSchema = Schema.object({
  imageUrls: Schema.array(String).default([]),
  currentIndex: Schema.number().default(0),
  fitMode: Schema.union(['cover', 'contain', 'repeat']).default('cover'),
  opacity: Schema.number().min(0).max(1).default(1),
  blur: Schema.number().min(0).default(0),
  enabled: Schema.boolean().default(false),
})

/** 默认配置值。 */
export const DEFAULT_BG_IMAGE_SETTINGS: BgImageSettings = {
  imageUrls: [],
  currentIndex: 0,
  fitMode: 'cover',
  opacity: 1,
  blur: 0,
  enabled: false,
}

/**
 * 注册 bg-image settings 命名空间。
 * @param ctx - Cordis 上下文。
 * @returns settings scope。
 */
export function registerSettings(ctx: Context) {
  const scope = ctx.settings.register(BG_IMAGE_NAMESPACE, BgImageSettingsSchema)
  return scope
}

// ─── Module Augmentation ──────────────────────────────────────────
// 告诉 TypeScript: Context 接口上存在 `settings` 属性。
//
// 为什么需要?
//   - `settings` 包在自身源码中声明了这个 augmentation,但我们的 tsconfig
//     只 include 了 src/**/*.ts,不会拉取 node_modules 或 packages 下的
//     其他源文件来合并类型。
//   - 所以我们需要在自己的源文件中重复声明,让 tsc 在编译本插件时知道
//     ctx.settings 的类型。
//
// SettingsProvider.register() 返回 SettingsScope<T>,提供 get/update/replace/watch。
declare module '@deepseek-ai/cordis' {
  interface Context {
    settings: import('@deepseek-ai/dsh-settings').SettingsProvider
  }
}
