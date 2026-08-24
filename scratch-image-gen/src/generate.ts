/**
 * 顶层 dispatch:在 tool 层调用这里,把工具参数 + 解析过的输入统一派给 provider adapter。
 *
 * 流程:
 * 1. 读 settings,确定 provider 与 model;
 * 2. 检查 enabled + apiKey,未配置则友好报错;
 * 3. 若 I2I:逐条解析 user input,按 provider 协议转 bytes 或 url;
 * 4. 调 adapter,下载/落盘;
 * 5. 通过 `ctx.get('attachments')` 取得 attachment 引用,供 GUI 渲染。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { resolveInput } from './input'
import { bailianAdapter } from './providers/bailian'
import { openaiAdapter } from './providers/openai'
import { minimaxAdapter } from './providers/minimax'
import { mediaTypeToExt, type ImageGenSettings } from './settings'
import type {
  GeneratedImage,
  ProviderConfig,
  ProviderId,
  ProviderInputImage,
} from './types'

const ADAPTERS = {
  openai: openaiAdapter,
  bailian: bailianAdapter,
  minimax: minimaxAdapter,
} as const

export interface GenerateRequest {
  prompt: string
  /** 缺省走 settings.defaultProvider,tool 也可显式覆盖。 */
  providerId?: ProviderId
  /** 覆盖该 provider 的 default model。 */
  model?: string
  size?: string
  n?: number
  seed?: number
  /** I2I:输入图 raw strings(URL / 路径)。空数组 = T2I。 */
  images?: string[]
  /** Bailian I2I 专用。 */
  function?: string
  strength?: number
  tag?: string
}

export interface GenerateResultItem {
  path: string
  attachment: ImageAttachmentRef | null
  prompt: string
  seed?: number
  provider: ProviderId
  model: string
}

export interface GenerateResult {
  images: GenerateResultItem[]
  provider: ProviderId
  model: string
}

export async function generate(
  req: GenerateRequest,
  ctx: Context,
  settings: ImageGenSettings,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<GenerateResult> {
  const providerId = req.providerId ?? settings.defaultProvider
  const adapter = ADAPTERS[providerId]
  const baseConfig = settings.providers[providerId]
  if (!baseConfig) {
    throw new Error(`unknown provider: ${providerId}`)
  }
  if (!baseConfig.enabled) {
    throw new Error(
      `provider "${providerId}" is not enabled. Enable it in Settings → image-gen → providers.${providerId}.enabled.`,
    )
  }
  if (!baseConfig.apiKey) {
    throw new Error(
      `provider "${providerId}" has no API key. Set Settings → image-gen → providers.${providerId}.apiKey.`,
    )
  }
  const config: ProviderConfig & { editModel?: string; pollTimeoutMs?: number } = {
    enabled: baseConfig.enabled,
    apiKey: baseConfig.apiKey,
    baseUrl: baseConfig.baseUrl,
    model: req.model ?? baseConfig.model,
  }
  if (providerId === 'bailian') {
    config.editModel = settings.bailianEditModel
    config.pollTimeoutMs = settings.pollTimeoutMs
  }

  const isI2I = (req.images?.length ?? 0) > 0
  const size = req.size ?? settings.defaultSize
  const n = req.n ?? settings.defaultN
  const tag = req.tag ?? 'image'

  let generated: GeneratedImage[]
  if (isI2I) {
    const inputs: ProviderInputImage[] = []
    for (const raw of req.images!) {
      const resolved = await resolveInput(raw, ctx, signal, adapter.acceptsInputKind, cwd)
      inputs.push(resolved)
    }
    generated = await adapter.imageToImage(
      {
        prompt: req.prompt,
        inputs,
        ...(size !== undefined ? { size } : {}),
        n,
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
        signal,
        ...(req.function !== undefined ? { function: req.function } : {}),
        ...(req.strength !== undefined ? { strength: req.strength } : {}),
      },
      config,
    )
  } else {
    generated = await adapter.textToImage(
      {
        prompt: req.prompt,
        ...(size !== undefined ? { size } : {}),
        n,
        ...(req.seed !== undefined ? { seed: req.seed } : {}),
        signal,
      },
      config,
    )
  }

  const dir = join(cwd, 'image-gen')
  await mkdir(dir, { recursive: true })
  const attachments = ctx.get('attachments')

  const items: GenerateResultItem[] = []
  for (let i = 0; i < generated.length; i++) {
    const img = generated[i]!
    const ext = mediaTypeToExt(img.mediaType)
    const seed = req.seed ?? Math.floor(Math.random() * 1_000_000)
    const fileName = `${tag}-${Date.now()}-${i}-${seed}.${ext}`
    const filePath = join(dir, fileName)
    await writeFile(filePath, img.bytes)
    let attachment: ImageAttachmentRef | null = null
    if (attachments !== undefined) {
      try {
        attachment = await attachments.saveImage({
          data: img.bytes,
          mediaType: img.mediaType,
          name: fileName,
        })
      } catch (err) {
        console.warn(`[image-gen] attachment save failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    items.push({
      path: filePath,
      attachment,
      prompt: req.prompt,
      ...(req.seed !== undefined ? { seed: req.seed } : {}),
      provider: providerId,
      model: config.model,
    })
  }
  return { images: items, provider: providerId, model: config.model }
}
