/**
 * 出图核心:调用 Pollinations.ai(免费、无需 API key)生成图片,
 * 并把字节写回会话工作区。插件以普通 Node 模块运行在宿主进程里,
 * 所以这里直接用全局 `fetch`(Node 24)+ `node:fs/promises`。
 *
 * Pollinations 接口:
 *   GET https://image.pollinations.ai/prompt/{prompt}?width=&height=&seed=&nologo=true&model=flux
 * 返回图片字节(JPEG/PNG),prompt 建议用英文以获得更好的 flux 效果。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface GenerateImageOptions {
  prompt: string
  width?: number
  height?: number
  seed?: number
  /** 工具执行的取消信号;与超时取交集。 */
  signal?: AbortSignal
}

export interface GeneratedImage {
  /** 原始图片字节。 */
  bytes: Uint8Array
  /** Pollinations 默认返回 JPEG。 */
  mediaType: 'image/jpeg' | 'image/png'
  width: number
  height: number
}

const POLLINATIONS_URL = 'https://image.pollinations.ai/prompt/'
const FETCH_TIMEOUT_MS = 120_000
/** 限流时最多重试 N 次(指数退避,起始 3s)。 */
const MAX_RETRIES = 4
const INITIAL_BACKOFF_MS = 3_000

/** 短暂 sleep,尊重外部取消信号。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function generateImage(opts: GenerateImageOptions): Promise<GeneratedImage> {
  const width = opts.width ?? 1024
  const height = opts.height ?? 1024
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    nologo: 'true',
    model: 'flux',
  })
  if (opts.seed !== undefined) params.set('seed', String(opts.seed))
  const url = `${POLLINATIONS_URL}${encodeURIComponent(opts.prompt)}?${params.toString()}`

  // 重试循环: 429 / 5xx / 网络错误 -> 指数退避(尊重取消信号)。
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = INITIAL_BACKOFF_MS * 2 ** (attempt - 1)
      try {
        await sleep(backoff, opts.signal)
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error))
      }
    }

    const timeoutSignal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : timeoutSignal

    try {
      const response = await fetch(url, { signal })
      if (response.status === 429 || response.status >= 500) {
        // 限流或服务端错误:重试。
        lastError = new Error(
          `image generation transient failure: HTTP ${response.status} ${response.statusText} for ${url.slice(0, 140)}…`,
        )
        continue
      }
      if (!response.ok) {
        // 4xx 其它(400/401/403)通常是 prompt 本身问题,不重试。
        throw new Error(
          `image generation failed: HTTP ${response.status} ${response.statusText} for ${url.slice(0, 140)}…`,
        )
      }
      const contentType = response.headers.get('content-type') ?? ''
      const mediaType: GeneratedImage['mediaType'] = contentType.includes('png')
        ? 'image/png'
        : 'image/jpeg'
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length === 0) {
        throw new Error('image generation returned an empty body')
      }
      return { bytes, mediaType, width, height }
    } catch (error) {
      // 网络级错误(连接拒绝、DNS)也重试。
      if (error instanceof Error && /fetch failed|aborted|TypeError/i.test(error.message)) {
        lastError = error
        if (opts.signal?.aborted) throw error
        continue
      }
      throw error
    }
  }
  throw lastError ?? new Error('image generation failed after retries')
}

/** 把图片写进工作区的 `wechat-images/` 目录,返回绝对路径。 */
export async function saveImageToWorkspace(options: {
  cwd: string
  bytes: Uint8Array
  mediaType: 'image/jpeg' | 'image/png'
  seed?: number
  tag: string
}): Promise<string> {
  const dir = join(options.cwd, 'wechat-images')
  await mkdir(dir, { recursive: true })
  const ext = options.mediaType === 'image/png' ? 'png' : 'jpg'
  const seed = options.seed ?? Math.floor(Math.random() * 1_000_000)
  const file = join(dir, `${options.tag}-${Date.now()}-${seed}.${ext}`)
  await writeFile(file, options.bytes)
  return file
}
