
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
  
  readonly coverPrompt?: string | undefined
  
  readonly coverPath?: string | undefined
  
  readonly coverAttachmentId?: string | undefined
  
  readonly inlineImages?: ReadonlyArray<InlineImageRow> | undefined
}


export interface InlineImageRow {
  readonly name: string
  readonly anchor: string
  readonly prompt: string
  readonly path: string
  readonly attachmentId: string
}


export interface DraftSummary {
  readonly id: number
  readonly topic: string
  readonly style: string
  readonly version: number
  readonly createdAt: number
}
