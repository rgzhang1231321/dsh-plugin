
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface GenerateImageOptions {
  prompt: string
  width?: number
  height?: number
  seed?: number
  
  signal?: AbortSignal
}

export interface GeneratedImage {
  
  bytes: Uint8Array
  
  mediaType: 'image/jpeg' | 'image/png'
  width: number
  height: number
}

const POLLINATIONS_URL = 'https://image.pollinations.ai/prompt/'
const FETCH_TIMEOUT_MS = 120_000

const MAX_RETRIES = 4
const INITIAL_BACKOFF_MS = 3_000


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
        
        lastError = new Error(
          `image generation transient failure: HTTP ${response.status} ${response.statusText} for ${url.slice(0, 140)}…`,
        )
        continue
      }
      if (!response.ok) {
        
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
