import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  COVER_PERSONA,
  DRAFT_PERSONA,
  INLINE_IMAGE_PERSONA,
  OUTLINE_PERSONA,
  POLISH_PERSONA,
  TITLE_PERSONA,
} from '../personas'
import type { DraftRow, InlineImageRow } from '../types'
import type { WechatSettings, Style } from '../settings'
import { generateImage, saveImageToWorkspace } from '../image'

/**
 * 把 SubagentResult 输出里所有 text block 拼成一个字符串。reasoning / tool-call /
 * image 类型的 block 被跳过 — persona 提示词里已经明确要求只输出纯文本,
 * 这里出现非文本 block 说明子代理违反了契约。
 */
function outputText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('')
}

/** 把标题阶段返回的多行文本拆成 trim 后的非空行。 */
function parseTitleLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => line.replace(/^[\d.\-)、\s]+/, '')) // 去掉开头的列表编号
    .filter(line => line.length > 0)
}

/**
 * `wechat-inline-images` 子代理承诺输出单行 JSON。
 * 解析失败时返回 null —— 调用方决定是否抛错或回退。
 */
interface SceneSpec {
  name: string
  anchor: string
  prompt: string
}
function parseSceneList(raw: string): SceneSpec[] | null {
  // 子代理偶尔会包一层 Markdown code fence 或在 JSON 前后留白; 先剥掉常见的包装。
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  // 找到第一个 '{' 到最后一个 '}' 之间的内容,容错。
  const first = stripped.indexOf('{')
  const last = stripped.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) return null
  const candidate = stripped.slice(first, last + 1)
  try {
    const parsed: unknown = JSON.parse(candidate)
    if (typeof parsed !== 'object' || parsed === null) return null
    const scenes = (parsed as { scenes?: unknown }).scenes
    if (!Array.isArray(scenes)) return null
    const result: SceneSpec[] = []
    for (const s of scenes) {
      if (typeof s !== 'object' || s === null) continue
      const obj = s as Record<string, unknown>
      if (
        typeof obj.name === 'string'
        && typeof obj.anchor === 'string'
        && typeof obj.prompt === 'string'
      ) {
        result.push({ name: obj.name, anchor: obj.anchor, prompt: obj.prompt })
      }
    }
    return result.length > 0 ? result : null
  } catch {
    return null
  }
}

/**
 * 一次性前台委派一个子代理并收集它的最终文本输出。无论结果如何都 dispose,
 * 让子代理在下一阶段开始前一定进入 quiescence 状态。
 */
async function runStage(
  ctx: Context,
  parent: Agent,
  signal: AbortSignal,
  provider: string,
  persona: string,
  prompt: string,
): Promise<string> {
  const run = await ctx.subagents.start(provider, {
    parent,
    signal,
    prompt: [{ type: 'text', text: prompt }],
    persona,
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed') {
      throw new Error(`subagent ${provider} ended with stopReason=${result.stopReason}`)
    }
    return outputText(result.output)
  } finally {
    await run.dispose()
  }
}

interface ArticleToolArgs {
  readonly topic: string
  readonly style?: Style
  readonly targetLength?: number
  /** 为 true 时在标题阶段后自动生成 1 张封面图 + (imageCount-1) 张正文配图。 */
  readonly generateCover?: boolean
  /** 覆盖 settings.imageCount: 一次调用总共要生成的图片数(1 张封面 + count-1 张正文)。 */
  readonly imageCount?: number
}

/** 工具结果中的正文配图形态 — 附件引用和路径都要返回,便于 GUI 渲染与用户复用。 */
interface InlineImageResult {
  name: string
  anchor: string
  prompt: string
  path: string
  attachment: ImageAttachmentRef
}

interface ArticleToolResult {
  draftId: number
  outline: string
  draft: string
  titles: string[]
  style: Style
  targetLength: number
  /** 工具为本次调用实际生成的总图片数(封面 + 正文)。 */
  imageCount: number
  coverPrompt?: string
  coverPath?: string
  /** 封面图的附件引用,供 render 直接挂进会话。 */
  coverAttachment?: ImageAttachmentRef
  /** 正文配图(场景 + 附件引用),按文章中位置顺序。 */
  inlineImages?: InlineImageResult[]
}

export function registerArticleTool(
  ctx: Context,
  scope: SettingsScope<WechatSettings>,
  drafts: KvTable<string, DraftRow>,
): void {
  ctx.tools.register(defineTool({
    name: 'wechat-article',
    description: [
      'Generate a WeChat Official Account article through a four-stage pipeline:',
      'outline -> draft -> polish -> titles. Each stage is a fresh sub-agent with',
      'a stage-specific system prompt. The full draft and titles are persisted',
      'to local storage; pass the returned draftId to list or fetch it later.',
      'Set generateCover=true to also draw a cover image and inline illustrations',
      'after the title stage. The default `imageCount` is 3 (1 cover + 2 inline),',
      'configurable in settings or per call via the `imageCount` argument (1-6).',
      'Inline illustrations are chosen by a sub-agent from the polished article body',
      'and their English prompts are tightly tied to specific arguments/evidence in',
      'the text. All images are saved under wechat-images/ in the workspace and',
      'attached to the chat.',
    ].join(' '),
    parameters: {
      topic: {
        type: 'string',
        required: true,
        description: 'Article topic or seed keywords. A short phrase is fine; the outline stage elaborates it.',
      },
      style: {
        type: 'string',
        description: 'Override the configured style for this run. One of: deep-analysis, storytelling, opinion.',
      },
      targetLength: {
        type: 'integer',
        description: 'Override the configured target word count (500-10000).',
      },
      generateCover: {
        type: 'boolean',
        description: 'Also generate a cover image plus inline illustrations after the title stage and save them into the workspace.',
      },
      imageCount: {
        type: 'integer',
        description: 'Override the configured total image count (1-6). 1 cover + (imageCount-1) inline illustrations.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          draftId: { type: 'integer', required: true },
          outline: { type: 'string', required: true },
          draft: { type: 'string', required: true },
          titles: { type: 'array', required: true, items: { type: 'string' } },
          style: { type: 'string', required: true },
          targetLength: { type: 'integer', required: true },
          imageCount: { type: 'integer', required: true },
          coverPrompt: { type: 'string' },
          coverPath: { type: 'string' },
          coverAttachment: {
            type: 'object',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
          inlineImages: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                anchor: { type: 'string', required: true },
                prompt: { type: 'string', required: true },
                path: { type: 'string', required: true },
                attachment: {
                  type: 'object',
                  additionalProperties: false,
                  required: true,
                  properties: {
                    attachmentId: { type: 'string', required: true },
                    mediaType: { type: 'string', required: true },
                    bytes: { type: 'integer', required: true },
                    width: { type: 'integer', required: true },
                    height: { type: 'integer', required: true },
                    name: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const blocks: ContentBlock[] = [{
          type: 'text',
          text: [
            `## WeChat article draft #${value.draftId} (${value.style}, ${value.targetLength} chars target, ${value.imageCount} images)`,
            '',
            '### Outline',
            value.outline,
            '',
            '### Draft',
            value.draft,
            '',
            '### Title candidates',
            ...value.titles.map((t, i) => `${i + 1}. ${t}`),
            value.coverPath !== undefined
              ? ['', '### Cover image', `- Saved to: \`${value.coverPath}\``].join('\n')
              : '',
            value.inlineImages !== undefined && value.inlineImages.length > 0
              ? [
                  '',
                  '### Inline illustrations',
                  ...value.inlineImages.map((img, i) => [
                    `**${i + 1}. ${img.name}** — ${img.anchor}`,
                    `- Saved to: \`${img.path}\``,
                  ].join('\n')),
                ].join('\n')
              : '',
          ].filter(line => line !== '').join('\n'),
        }]
        if (value.coverAttachment !== undefined) {
          // schema 推断出的附件形状与 AttachmentId 的 branded 类型只差一层,
          // 运行时就是同一个对象,这里做一次窄化转换以便挂进会话。
          blocks.push({ type: 'image', attachment: value.coverAttachment as unknown as ImageAttachmentRef })
        }
        if (value.inlineImages !== undefined) {
          for (const img of value.inlineImages) {
            blocks.push({ type: 'image', attachment: img.attachment as unknown as ImageAttachmentRef })
          }
        }
        return blocks
      },
    },
    async execute(args: ArticleToolArgs, exec) {
      if (!exec.agent) {
        throw new Error('wechat-article tool requires an owning agent (exec.agent was undefined)')
      }
      const base = scope.get()
      const style: Style = args.style ?? base.style
      const targetLength = args.targetLength ?? base.targetLength
      // 默认 imageCount=3 (1 封面 + 2 正文),范围 1..6。
      const requestedCount = args.imageCount ?? base.imageCount
      const imageCount = Math.max(1, Math.min(6, Math.floor(requestedCount)))
      const inlineCount = imageCount - 1

      const outline = await runStage(
        ctx, exec.agent, exec.signal,
        'wechat-outline', OUTLINE_PERSONA,
        `Topic: ${args.topic}\nStyle: ${style}\nTarget word count: ${targetLength}\nTone: ${base.tone}`,
      )

      const draft = await runStage(
        ctx, exec.agent, exec.signal,
        'wechat-draft', DRAFT_PERSONA,
        `Outline:\n${outline}\n\nTarget word count: ${targetLength}\nTone: ${base.tone}\n\nWrite the full article based on the outline above.`,
      )

      const polished = await runStage(
        ctx, exec.agent, exec.signal,
        'wechat-polish', POLISH_PERSONA,
        `Draft to polish:\n${draft}\n\nApply the polish rules to the draft above.`,
      )

      const titlesRaw = await runStage(
        ctx, exec.agent, exec.signal,
        'wechat-title', TITLE_PERSONA,
        `Polished article body:\n${polished}\n\nProduce 5 title candidates for the article above.`,
      )
      const titles = parseTitleLines(titlesRaw).slice(0, 5)
      if (titles.length === 0) {
        throw new Error('title stage produced no usable title lines')
      }

      // 可选的第五阶段: 封面图(标题级)。
      let coverPrompt: string | undefined
      let coverPath: string | undefined
      let coverAttachment: ImageAttachmentRef | null = null
      // 可选的第六阶段: 正文配图(场景级, 由子代理挑选与文章强相关的位置)。
      let inlineImages: InlineImageResult[] = []
      let inlineImagesForRow: InlineImageRow[] = []

      if (args.generateCover) {
        const cwd = exec.agent.session.header.cwd
        if (!cwd) {
          throw new Error('generateCover requires a session working directory (session header cwd was empty)')
        }
        const attachments = ctx.get('attachments')

        // 封面。
        const coverPromptRaw = await runStage(
          ctx, exec.agent, exec.signal,
          'wechat-cover', COVER_PERSONA,
          `Topic: ${args.topic}\nChosen title: ${titles[0]}\n\nWrite the cover image prompt.`,
        )
        coverPrompt = coverPromptRaw.trim()
        const coverGen = await generateImage({
          prompt: coverPrompt,
          width: base.imageWidth,
          height: base.imageHeight,
          signal: exec.signal,
        })
        coverPath = await saveImageToWorkspace({
          cwd,
          bytes: coverGen.bytes,
          mediaType: coverGen.mediaType,
          tag: 'cover',
        })
        if (attachments !== undefined) {
          const fileName = coverPath.split(/[\\/]/).pop()
          coverAttachment = await attachments.saveImage({
            data: coverGen.bytes,
            mediaType: coverGen.mediaType,
            ...(fileName !== undefined ? { name: fileName } : {}),
          })
        }

        // 正文配图 — 由 wechat-inline-images 子代理挑选位置并写英文提示词,
        // 然后并发调出图服务。相关性由子代理的 persona 强约束(必须引用文章中的具体细节)。
        if (inlineCount > 0) {
          const scenesRaw = await runStage(
            ctx, exec.agent, exec.signal,
            'wechat-inline-images', INLINE_IMAGE_PERSONA,
            [
              `Topic: ${args.topic}`,
              `Style: ${style}`,
              `Tone: ${base.tone}`,
              `Required inline scenes: ${inlineCount}`,
              '',
              'Outline:',
              outline,
              '',
              'Polished article body:',
              polished,
              '',
              'Pick the most informative positions in the article and write the JSON response now.',
            ].join('\n'),
          )
          const scenes = parseSceneList(scenesRaw)
          if (scenes === null) {
            // JSON 解析失败, 抛出以便用户看到; 不会写出半截图。
            throw new Error(`wechat-inline-images returned invalid JSON: ${scenesRaw.slice(0, 200)}`)
          }
          // 截到用户要求的数量; 子代理可能多给。
          const chosen = scenes.slice(0, inlineCount)
          if (chosen.length === 0) {
            throw new Error('wechat-inline-images returned no usable scenes')
          }

          // 串行出图 + 间隔, 避免 Pollinations 限流;
          // 重试/退避由 generateImage 内部处理。单张失败直接抛错让用户看到。
          const flat: { row: InlineImageRow, resultEntry: InlineImageResult }[] = []
          for (let i = 0; i < chosen.length; i++) {
            const scene = chosen[i]!
            if (i > 0) {
              // 串行间隙 1.5s, 让上游限流窗口过去。
              await new Promise<void>(resolve => setTimeout(resolve, 1500))
            }
            const gen = await generateImage({
              prompt: scene.prompt,
              width: base.imageWidth,
              height: base.imageHeight,
              signal: exec.signal,
            })
            const fileName = `inline-${String(i + 1).padStart(2, '0')}-${scene.name.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 24) || 'scene'}`
            const path = await saveImageToWorkspace({
              cwd,
              bytes: gen.bytes,
              mediaType: gen.mediaType,
              tag: fileName,
            })
            let attachment: ImageAttachmentRef | null = null
            if (attachments !== undefined) {
              const nameOnly = path.split(/[\\/]/).pop()
              attachment = await attachments.saveImage({
                data: gen.bytes,
                mediaType: gen.mediaType,
                ...(nameOnly !== undefined ? { name: nameOnly } : {}),
              })
            }
            if (attachment === null) {
              // 附件服务不可用,跳过这张图。
              continue
            }
            flat.push({
              row: {
                name: scene.name,
                anchor: scene.anchor,
                prompt: scene.prompt,
                path,
                attachmentId: attachment.attachmentId,
              },
              resultEntry: {
                name: scene.name,
                anchor: scene.anchor,
                prompt: scene.prompt,
                path,
                attachment,
              },
            })
          }
          inlineImagesForRow = flat.map(f => f.row)
          inlineImages = flat.map(f => f.resultEntry)
        }
      }

      const now = Date.now()
      const id = now.toString()
      const row: DraftRow = {
        id: now,
        topic: args.topic,
        style,
        outline,
        draft: polished,
        titles,
        version: 1,
        createdAt: now,
        updatedAt: now,
        coverPrompt,
        coverPath,
        coverAttachmentId: coverAttachment?.attachmentId,
        inlineImages: inlineImagesForRow.length > 0 ? inlineImagesForRow : undefined,
      }
      await drafts.put(id, row)

      const result: ArticleToolResult = {
        draftId: now,
        outline,
        draft: polished,
        titles,
        style,
        targetLength,
        imageCount,
        ...(coverPrompt !== undefined ? { coverPrompt } : {}),
        ...(coverPath !== undefined ? { coverPath } : {}),
        ...(coverAttachment !== null ? { coverAttachment } : {}),
        ...(inlineImages.length > 0 ? { inlineImages } : {}),
      }
      return result
    },
  }))
}
