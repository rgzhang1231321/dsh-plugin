/**
 * `image-gen` tool:统一的文生图 / 图生图入口。
 *
 * 参数:
 * - `prompt`(必填):文本描述或变换指令。
 * - `images`(可选):I2I 输入图,字符串数组,每条可以是:
 *     - `https?://...` 公网 URL(Bailian I2I 唯一支持的形式)
 *     - `file://...` 或绝对/相对路径 — 相对路径基于会话 cwd
 *   留空 = T2I,非空 = I2I。
 * - `provider`(可选):'openai' | 'bailian' | 'minimax',覆盖 default。
 * - `model`(可选):覆盖该 provider 的默认 model。
 * - `size`(可选):'1024x1024'、'16:9' 等,provider 自动适配。
 * - `n`(可选,1..9):一次出几张,默认 1。
 * - `seed`(可选):复现种子。
 * - `tag`(可选):文件名 tag,默认 'image'。
 * - `function`(可选,仅 Bailian I2I):'expand' / 'remove_watermark' / 'description_edit' / 'stylization_all' 等。
 * - `strength`(可选,仅 Bailian I2I):0..1。
 *
 * 输出:每张图返回 path、attachment、provider、model;`render` 把它们转成 text + image block 挂回对话。
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { Context } from '@deepseek-ai/cordis'
import { generate, type GenerateResultItem } from '../generate'
import type { ProviderId } from '../types'
import type { ImageGenSettings } from '../settings'

interface ImageGenArgs {
  prompt: string
  images?: string[]
  provider?: ProviderId
  model?: string
  size?: string
  n?: number
  seed?: number
  tag?: string
  function?: string
  strength?: number
}

interface ImageGenResultImage {
  path: string
  attachment?: ImageAttachmentRef
  prompt: string
  seed?: number
  provider: string
  model: string
}

interface ImageGenResult {
  images: ImageGenResultImage[]
  provider: string
  model: string
}

export function registerImageGenTool(
  ctx: Context,
  scope: SettingsScope<ImageGenSettings>,
): void {
  ctx.tools.register(defineTool({
    name: 'image-gen',
    description: [
      'Generate one or more images from a text prompt (text-to-image) or transform an input image',
      'using a prompt (image-to-image). Supports three external providers:',
      '  - "openai"   — synchronous, OpenAI gpt-image-1 / dall-e-3 (multipart for I2I)',
      '  - "bailian"  — Aliyun DashScope (async submit + poll; I2I requires a public URL for the input image)',
      '  - "minimax"  — MiniMax image_generation (synchronous; I2I via subject_reference)',
      'Default provider in this build is "minimax". If the user does not name a provider, pass',
      '`provider="minimax"` (or omit the field) so the call actually works — the other providers',
      'have no API key configured by default. Leave `images` empty for text-to-image; provide one',
      'or more image references (http(s):// URL, file:// URL, or absolute/relative path under the',
      'session working directory) to do image-to-image.',
      'Generated images are saved under <cwd>/image-gen/ and attached to the conversation.',
    ].join(' '),
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Text prompt. For T2I describe the desired image; for I2I describe the transformation.',
      },
      images: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional input image references for image-to-image. Each: http(s):// URL, file:// URL, or path. Empty/omitted = text-to-image.',
      },
      provider: {
        type: 'string',
        description: 'Override the default provider. One of: openai, bailian, minimax.',
      },
      model: {
        type: 'string',
        description: 'Override the default model for the chosen provider.',
      },
      size: {
        type: 'string',
        description: 'Image size, e.g. "1024x1024" or "16:9". Provider-specific. Default: settings.defaultSize.',
      },
      n: {
        type: 'integer',
        description: 'How many images to generate in this call. Range 1..9. Default 1.',
      },
      seed: {
        type: 'integer',
        description: 'Optional reproducible seed. Not all providers honor it.',
      },
      tag: {
        type: 'string',
        description: 'Filename tag, e.g. "cover" or "inline". Default "image".',
      },
      function: {
        type: 'string',
        description: 'Bailian I2I only — operation type, e.g. "expand", "remove_watermark", "description_edit", "stylization_all".',
      },
      strength: {
        type: 'number',
        description: 'Bailian I2I only — change strength 0..1.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                attachment: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    attachmentId: { type: 'string' },
                    mediaType: { type: 'string' },
                    bytes: { type: 'integer' },
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                    name: { type: 'string' },
                  },
                },
                prompt: { type: 'string' },
                seed: { type: 'integer' },
                provider: { type: 'string' },
                model: { type: 'string' },
              },
            },
          },
          provider: { type: 'string' },
          model: { type: 'string' },
        },
      },
      render: (_args, value) => buildRenderBlocks(value as unknown as ImageGenResult),
    },
    async execute(args: ImageGenArgs, exec) {
      if (!exec.agent) {
        throw new Error('image-gen tool requires an owning agent (exec.agent was undefined)')
      }
      const cwd = exec.agent.session.header.cwd
      if (!cwd) {
        throw new Error('image-gen tool requires a session working directory (session header cwd was empty)')
      }
      const settings = scope.get()
      const result = await generate(
        {
          prompt: args.prompt,
          ...(args.provider !== undefined ? { providerId: args.provider } : {}),
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(args.size !== undefined ? { size: args.size } : {}),
          ...(args.n !== undefined ? { n: args.n } : {}),
          ...(args.seed !== undefined ? { seed: args.seed } : {}),
          ...(args.images !== undefined ? { images: args.images } : {}),
          ...(args.function !== undefined ? { function: args.function } : {}),
          ...(args.strength !== undefined ? { strength: args.strength } : {}),
          ...(args.tag !== undefined ? { tag: args.tag } : {}),
        },
        ctx,
        settings,
        cwd,
        exec.signal,
      )
      return toToolResult(result)
    },
  }))
}

function toToolResult(result: { images: GenerateResultItem[]; provider: string; model: string }): ImageGenResult {
  return {
    images: result.images.map(item => {
      const out: ImageGenResultImage = {
        path: item.path,
        prompt: item.prompt,
        provider: item.provider,
        model: item.model,
        ...(item.seed !== undefined ? { seed: item.seed } : {}),
        ...(item.attachment !== null ? { attachment: item.attachment } : {}),
      }
      return out
    }),
    provider: result.provider,
    model: result.model,
  }
}

function buildRenderBlocks(value: ImageGenResult): ContentBlock[] {
  const blocks: ContentBlock[] = [{
    type: 'text',
    text: [
      `## Generated ${value.images.length} image(s) via ${value.provider} (${value.model})`,
      '',
      ...value.images.map((img, i) => {
        const lines = [`**${i + 1}.** \`${img.path}\` — provider=${img.provider} model=${img.model}`]
        if (img.seed !== undefined) lines.push(`  - seed: ${img.seed}`)
        return lines.join('\n')
      }),
    ].join('\n'),
  }]
  for (const img of value.images) {
    if (img.attachment !== undefined) {
      // schema 推断出的形状与 ImageAttachmentRef branded 类型运行时一致,做一次窄化。
      blocks.push({ type: 'image', attachment: img.attachment as unknown as ImageAttachmentRef })
    }
  }
  return blocks
}
