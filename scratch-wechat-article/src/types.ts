/**
 * 微信公众号文章草稿的持久化结构。
 *
 * 每次调用 `wechat-article` 工具生成一行。`outline` 是大纲阶段子代理的原始输出;
 * `draft` 是润色后的最终正文;`titles` 是标题阶段给出的 3-5 个候选标题。
 * `version` 在原地替换草稿时递增。
 */
export interface DraftRow {
  readonly id: number
  readonly topic: string
  readonly style: string
  readonly outline: string
  readonly draft: string
  readonly titles: string[]
  readonly version: number
  readonly createdAt: number
  readonly updatedAt: number
  /** 封面图生成时的英文画面提示词(仅 generateCover 时写入)。 */
  readonly coverPrompt?: string | undefined
  /** 封面图在工作区的绝对路径。 */
  readonly coverPath?: string | undefined
  /** 封面图在会话里的附件引用 id,用于 GUI 渲染。 */
  readonly coverAttachmentId?: string | undefined
  /** 正文配图列表:每条包含场景标签、引用的文章立论、画面提示词、落盘路径、附件 id。 */
  readonly inlineImages?: ReadonlyArray<InlineImageRow> | undefined
}

/** 单张正文配图的持久化形态。 */
export interface InlineImageRow {
  readonly name: string
  readonly anchor: string
  readonly prompt: string
  readonly path: string
  readonly attachmentId: string
}

/** `wechat-list-drafts` 返回的字段子集 — 体积小到能塞进模型上下文。 */
export interface DraftSummary {
  readonly id: number
  readonly topic: string
  readonly style: string
  readonly version: number
  readonly createdAt: number
}
