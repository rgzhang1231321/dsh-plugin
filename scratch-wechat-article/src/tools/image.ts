/**
 * `wechat-image` 工具:给定一段画面描述,调用 Pollinations.ai 生成插图/封面,
 * 存一份到会话工作区 `wechat-images/`,并作为附件挂进对话,让 GUI 直接渲染。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { generateImage, saveImageToWorkspace } from '../image'

interface ImageToolArgs {
  prompt: string
  width?: number
  height?: number
  seed?: number
  /** 保存子目录名,用于区分封面/插图等用途。 */
  tag?: string
}

interface ImageToolResult {
  path: string
  /** 会话内渲染用的附件引用(纯 JSON,可序列化)。 */
  attachment?: ImageAttachmentRef
  prompt: string
  seed?: number
}

export function registerImageTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'wechat-image',
    description: [
      'Generate an illustration or cover image for a WeChat article (free key-less backend,',
      'Pollinations flux). A copy is saved into the session workspace under wechat-images/',
      'and the image is attached to the conversation so it renders inline. Write the prompt',
      'as a vivid English scene description; the model maps style/tone keywords to visual style.',
    ].join(' '),
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Vivid English scene description of the image to draw (no text/watermark words).',
      },
      width: {
        type: 'integer',
        description: 'Pixel width (64-2048). Defaults to 1024.',
      },
      height: {
        type: 'integer',
        description: 'Pixel height (64-2048). Defaults to 1024.',
      },
      seed: {
        type: 'integer',
        description: 'Optional reproducible seed.',
      },
      tag: {
        type: 'string',
        description: 'Short file-name tag, e.g. cover or inline. Defaults to "image".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          attachment: {
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
          prompt: { type: 'string', required: true },
          seed: { type: 'integer' },
        },
      },
      render: (_args, value) => {
        const blocks: import('@deepseek-ai/dsh-llm').ContentBlock[] = [{
          type: 'text',
          text: [
            '## Generated image',
            '',
            `- Saved to: \`${value.path}\``,
            `- Prompt: ${value.prompt}`,
            value.seed !== undefined ? `- Seed: ${value.seed}` : '',
          ].filter(line => line !== '').join('\n'),
        }]
        if (value.attachment !== undefined) {
          // schema 推断出的附件形状与 AttachmentId 的 branded 类型只差一层,
          // 运行时就是同一个对象,这里做一次窄化转换以便挂进会话。
          blocks.push({ type: 'image', attachment: value.attachment as unknown as ImageAttachmentRef })
        }
        return blocks
      },
    },
    async execute(args: ImageToolArgs, exec) {
      if (!exec.agent) {
        throw new Error('wechat-image tool requires an owning agent (exec.agent was undefined)')
      }
      const cwd = exec.agent.session.header.cwd
      if (!cwd) {
        throw new Error('wechat-image tool requires a session working directory (session header cwd was empty)')
      }
      const width = args.width ?? 1024
      const height = args.height ?? 1024
      const tag = args.tag ?? 'image'

      const generated = await generateImage({
        prompt: args.prompt,
        width,
        height,
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
        signal: exec.signal,
      })
      const path = await saveImageToWorkspace({
        cwd,
        bytes: generated.bytes,
        mediaType: generated.mediaType,
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
        tag,
      })

      let attachment: ImageAttachmentRef | null = null
      const attachments = ctx.get('attachments')
      if (attachments !== undefined) {
        const fileName = path.split(/[\\/]/).pop()
        attachment = await attachments.saveImage({
          data: generated.bytes,
          mediaType: generated.mediaType,
          ...(fileName !== undefined ? { name: fileName } : {}),
        })
      }

      const result: ImageToolResult = {
        path,
        prompt: args.prompt,
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
        ...(attachment !== null ? { attachment } : {}),
      }
      return result
    },
  }))
}
