import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { WechatSettings, Style, Tone } from './settings'

/**
 * 每种风格的写作指引。短而明确 — 模型本来就会写东西,这里只是给出编辑框架,
 * 让四个子代理和任何直接生成正文的调用都保持一致。
 */
const STYLE_GUIDANCE: Record<Style, string> = {
  'deep-analysis': '结构化深度分析：每段先立论再举证，结尾给可执行建议。',
  'storytelling': '叙事化写法：开头用冲突/场景钩子，主体推进情节，结尾收束情绪。',
  'opinion': '观点输出：明确立场，论据分层，结尾给行动号召。',
}

const TONE_GUIDANCE: Record<Tone, string> = {
  warm: '亲切、对话感，多用第二人称。',
  professional: '克制、信息密度高，避免感叹号和口头禅。',
  casual: '轻快、句子短促，允许表情符号和网络流行语。',
}

/**
 * 注册一个 system-prompt section,每次组装 prompt 时从 `wechat-article` settings
 * 命名空间重新读取当前的 style/tone。`text` 回调闭包持有 scope,因此 section
 * 会自动反映用户对 settings 的修改,无需显式反订阅;prompt 组装服务会在
 * 每次 `system-prompt/change` 事件时重新求值回调。
 */
export function registerStyleSection(
  ctx: Context,
  scope: SettingsScope<WechatSettings>,
): void {
  ctx.systemPrompt.section({
    name: 'wechat-article:style',
    order: 10,
    text: () => {
      const s = scope.get()
      return [
        'The user is writing WeChat Official Account articles with this plugin.',
        `Active style: ${s.style} — ${STYLE_GUIDANCE[s.style]}`,
        `Active tone: ${s.tone} — ${TONE_GUIDANCE[s.tone]}`,
        `Target length: ~${s.targetLength} characters.`,
        'When the user asks for a WeChat article without explicit style/length, defer to the values above. The dedicated `wechat-article` tool runs the four-stage pipeline; pass `generateCover: true` to also draw a cover image. By default the pipeline also generates two inline illustrations (`wechat-inline-images` sub-agent picks positions from the article body and writes the English prompts), totalling `imageCount` images (1 cover + imageCount-1 inline, default 3, range 1-6); override with the `imageCount` tool argument. The `wechat-image` tool generates standalone illustrations/covers and saves them under wechat-images/ in the workspace. The `wechat-list-drafts` tool retrieves prior drafts.',
      ].join('\n')
    },
  })
}
