/**
 * 类型共享层。
 *
 * GeneratedImage 是 adapter 归一化之后的产物,带可序列化的字节、媒体类型与像素尺寸。
 * ProviderInputImage 是 dispatcher 准备好、可以直接交给单个 provider 调用的输入图形态。
 * UserImageInput 是 tool 收到的"原始"输入,可能是 URL、本地路径、附件 ID 之一,
 * 解析后才转成 ProviderInputImage。
 */
export type ProviderId = 'openai' | 'bailian' | 'minimax'

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp'

/** 单个 provider 配置:启用、API key、baseUrl、默认 model。 */
export interface ProviderConfig {
  enabled: boolean
  apiKey: string
  baseUrl: string
  model: string
}

/** Adapter 拿到的归一化输入图,形态依 provider 协议而异。 */
export type ProviderInputImage =
  | { kind: 'bytes'; bytes: Uint8Array; mediaType: 'image/png' | 'image/jpeg' }
  | { kind: 'url'; url: string }

/** Adapter 输出的单张图(已下载或解码,直接落盘即用)。 */
export interface GeneratedImage {
  bytes: Uint8Array
  mediaType: ImageMediaType
  width: number
  height: number
  /** provider 返回的源 URL(若有),仅供日志。 */
  sourceUrl?: string | undefined
}

/** Adapter T2I 调用参数。 */
export interface AdapterT2IOptions {
  prompt: string
  /** '1024x1024' 形式,provider 内部按需转换。 */
  size?: string | undefined
  n?: number | undefined
  seed?: number | undefined
  signal?: AbortSignal | undefined
}

/** Adapter I2I 调用参数。 */
export interface AdapterI2IOptions extends AdapterT2IOptions {
  inputs: ProviderInputImage[]
  /** Bailian I2I 专用:操作类型,如 'expand' / 'remove_watermark'。 */
  function?: string | undefined
  /** Bailian I2I 专用:变化强度 0..1。 */
  strength?: number | undefined
}

/** Adapter 协议:每个 provider 一个实现。 */
export interface ProviderAdapter {
  readonly id: ProviderId
  /** 该 provider 接受输入图的形态;dispatcher 据此决定怎么 resolve user input。 */
  readonly acceptsInputKind: 'bytes-or-url' | 'url-only'
  textToImage(opts: AdapterT2IOptions, config: ProviderConfig): Promise<GeneratedImage[]>
  imageToImage(opts: AdapterI2IOptions, config: ProviderConfig): Promise<GeneratedImage[]>
}

/** Tool 收到的一条"原始"图像输入,需进一步解析。 */
export type UserImageInput =
  | { kind: 'url'; url: string }
  | { kind: 'file-path'; path: string }
