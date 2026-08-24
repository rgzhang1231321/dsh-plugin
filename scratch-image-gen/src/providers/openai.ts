/**
 * OpenAI Images 适配。
 *
 * - T2I:`POST {baseUrl}/v1/images/generations`,body 是 JSON,响应含 `data[].b64_json`(gpt-image-1)或 `data[].url`(dall-e-3)。
 * - I2I:`POST {baseUrl}/v1/images/edits`,**multipart/form-data**,字段 `image`(PNG 字节) + 可选 `mask` + `prompt` 等。
 * - 鉴权:`Authorization: Bearer <apiKey>`。
 * - 大小:用 `1024x1024` 字符串,gpt-image-1 还支持 `auto`、dall-e-3 只支持枚举。
 *
 * 注意:gpt-image-1 的 `response_format` 强制 base64,`url` 模式不被支持;dall-e-3 默认 url。
 * 这里统一用 b64_json 输出,本地再解码成字节,免得受 provider 差异影响。
 */

import { normalizeSizeForProvider } from '../settings'
import type {
  AdapterI2IOptions,
  AdapterT2IOptions,
  GeneratedImage,
  ProviderAdapter,
  ProviderConfig,
  ProviderInputImage,
} from '../types'
import {
  decodeBase64,
  downloadBytes,
  fetchJson,
  isRetryableFetchError,
  isRetryableStatus,
  sleep,
} from './base'

const TIMEOUT_MS = 120_000
const MAX_RETRIES = 4
const INITIAL_BACKOFF_MS = 3_000

export const openaiAdapter: ProviderAdapter = {
  id: 'openai',
  acceptsInputKind: 'bytes-or-url',
  async textToImage(opts: AdapterT2IOptions, config: ProviderConfig): Promise<GeneratedImage[]> {
    const url = `${stripTrailingSlash(config.baseUrl)}/v1/images/generations`
    const body = {
      model: config.model,
      prompt: opts.prompt,
      ...(opts.n !== undefined ? { n: opts.n } : { n: 1 }),
      ...(opts.size !== undefined ? { size: normalizeSizeForProvider('openai', opts.size) } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      response_format: 'b64_json',
    }
    const data = await callWithRetry(() => fetchJson({
      method: 'POST',
      url,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: TIMEOUT_MS,
      signal: opts.signal,
    }), opts.signal, 'openai T2I')
    return decodeOpenAIResponse(data, opts.n ?? 1, opts.size)
  },

  async imageToImage(opts: AdapterI2IOptions, config: ProviderConfig): Promise<GeneratedImage[]> {
    if (opts.inputs.length === 0) {
      throw new Error('openai imageToImage: inputs is empty')
    }
    // OpenAI /v1/images/edits 接受 multipart;目前只取第一张作为主输入。
    const first = opts.inputs[0]!
    const pngBytes = await ensurePngBytes(first, opts.signal)
    const url = `${stripTrailingSlash(config.baseUrl)}/v1/images/edits`
    const form = new FormData()
    form.append('model', config.model)
    form.append('prompt', opts.prompt)
    form.append('image', new Blob([pngBytes as BlobPart], { type: 'image/png' }), 'input.png')
    if (opts.n !== undefined) form.append('n', String(opts.n))
    if (opts.size !== undefined) form.append('size', normalizeSizeForProvider('openai', opts.size))

    const data = await callWithRetry(() => fetchJson({
      method: 'POST',
      url,
      headers: { 'Authorization': `Bearer ${config.apiKey}` },
      body: form,
      timeoutMs: TIMEOUT_MS,
      signal: opts.signal,
    }), opts.signal, 'openai I2I')
    return decodeOpenAIResponse(data, opts.n ?? 1, opts.size)
  },
}

async function decodeOpenAIResponse(
  data: unknown,
  n: number,
  size?: string,
): Promise<GeneratedImage[]> {
  const obj = data as { data?: Array<{ b64_json?: string; url?: string }> }
  if (!obj || !Array.isArray(obj.data) || obj.data.length === 0) {
    throw new Error(`openai: empty or malformed response: ${JSON.stringify(data).slice(0, 200)}`)
  }
  const fallbackDim = parseSize(size ?? '1024x1024')
  const results: GeneratedImage[] = []
  for (let i = 0; i < obj.data.length; i++) {
    const item = obj.data[i]!
    if (item.b64_json) {
      const bytes = decodeBase64(item.b64_json)
      results.push({
        bytes,
        mediaType: 'image/png',
        width: fallbackDim?.w ?? 1024,
        height: fallbackDim?.h ?? 1024,
      })
    } else if (item.url) {
      const bytes = await downloadBytes(item.url)
      results.push({
        bytes,
        mediaType: 'image/png',
        width: fallbackDim?.w ?? 1024,
        height: fallbackDim?.h ?? 1024,
        sourceUrl: item.url,
      })
    } else {
      throw new Error(`openai: data[${i}] has neither b64_json nor url`)
    }
  }
  if (results.length !== n && n > 1) {
    console.warn(`[image-gen:openai] requested n=${n}, got ${results.length}`)
  }
  return results
}

/** 解析 "1024x1024" 这种串,缺省返回 null。 */
function parseSize(s: string): { w: number; h: number } | null {
  const m = s.match(/^(\d+)\s*[xX*]\s*(\d+)$/)
  if (!m) return null
  return { w: Number(m[1]), h: Number(m[2]) }
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

/** 把任意 ProviderInputImage 规范化成 PNG 字节(OpenAI /v1/images/edits 要求)。 */
async function ensurePngBytes(input: ProviderInputImage, signal: AbortSignal | undefined): Promise<Uint8Array> {
  if (input.kind === 'bytes') {
    if (input.mediaType !== 'image/png') {
      // OpenAI /edits 文档要求 PNG;非 PNG 先原样提交,服务端会拒;错误信息更明确。
      console.warn(`[image-gen:openai] input mediaType=${input.mediaType}; /v1/images/edits requires PNG`)
    }
    return input.bytes
  }
  // url-only 模式不应到这里;bytes-or-url 下 url 出现时由 dispatcher 决定,
  // 实际实现里 dispatcher 看到 OpenAI 时会自己 fetch url 取字节。这里兜底再取一次。
  return await downloadBytes(input.url, signal)
}

async function callWithRetry(
  op: () => Promise<{ status: number; statusText: string; json: unknown }>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<unknown> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const backoff = INITIAL_BACKOFF_MS * 2 ** (attempt - 1)
      try { await sleep(backoff, signal) } catch (e) { throw e instanceof Error ? e : new Error(String(e)) }
    }
    try {
      const res = await op()
      if (isRetryableStatus(res.status)) {
        lastError = new Error(`${label}: HTTP ${res.status} ${res.statusText}: ${truncate(res.json)}`)
        console.warn(`[image-gen:${label}] attempt ${attempt + 1}/${MAX_RETRIES + 1} got ${res.status}, retrying`)
        continue
      }
      if (!res.status.toString().startsWith('2')) {
        throw new Error(`${label}: HTTP ${res.status} ${res.statusText}: ${truncate(res.json)}`)
      }
      return res.json
    } catch (err) {
      if (isRetryableFetchError(err)) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (signal?.aborted) throw lastError
        console.warn(`[image-gen:${label}] attempt ${attempt + 1}/${MAX_RETRIES + 1} network error: ${lastError.message}, retrying`)
        continue
      }
      throw err
    }
  }
  throw lastError ?? new Error(`${label}: failed after retries`)
}

function truncate(v: unknown, max = 300): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? s.slice(0, max) + '…' : s
}
