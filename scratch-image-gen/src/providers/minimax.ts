/**
 * MiniMax 图片生成适配。
 *
 * 协议特点:
 * 1. 单一端点 `POST {baseUrl}/image_generation`,T2I / I2I 都走它。baseUrl
 *    由用户在 settings.providers.minimax.baseUrl 配置,官方推荐值
 *    `https://api.minimaxi.com/v1`(已含版本路径),适配层不再追加 /v1。
 * 2. I2I 通过加 `subject_reference: [{type: 'character', image_file: <url|data URL>}]` 实现。
 * 3. `subject_reference[].type` 当前只支持 'character',即"以图中人物为主体换场景"。
 *    非人物/通用风格迁移目前 MiniMax 协议不直接支持。
 * 4. `response_format` 选 'url'(默认)/ 'base64';URL 24h 过期,本地立刻下载。
 * 5. 大小:默认用 `aspect_ratio` 枚举,`image-01` 也支持 `width/height`(8 倍数,512..2048)。
 * 6. 错误码在 `base_resp.status_code`,常见:
 *    1002 限流、1004 鉴权失败、1008 余额不足、1026 内容敏感、
 *    2013 参数错、2049 key 无效。
 */

import { encodeBase64 } from './base'
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

const ERROR_CODE_MESSAGES: Record<number, string> = {
  1002: '限流,请稍后重试',
  1004: '鉴权失败 — 请检查 MiniMax API key',
  1008: '账户余额不足',
  1026: '内容被风控拦截 — 请修改 prompt',
  2013: '参数错误 — 请检查 model/size/prompt',
  2049: 'API key 无效',
}

export const minimaxAdapter: ProviderAdapter = {
  id: 'minimax',
  acceptsInputKind: 'bytes-or-url',
  async textToImage(opts: AdapterT2IOptions, config: ProviderConfig): Promise<GeneratedImage[]> {
    const body = buildBody(config.model, opts)
    const json = await callMinimax(() => fetchJson({
      method: 'POST',
      url: `${stripTrailingSlash(config.baseUrl)}/image_generation`,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: TIMEOUT_MS,
      signal: opts.signal,
    }), opts.signal, 'minimax T2I')
    return await decodeMinimaxResponse(json, opts.n ?? 1, opts.size)
  },

  async imageToImage(opts: AdapterI2IOptions, config: ProviderConfig): Promise<GeneratedImage[]> {
    if (opts.inputs.length === 0) {
      throw new Error('minimax imageToImage: inputs is empty')
    }
    if (opts.inputs.length > 1) {
      console.warn(`[image-gen:minimax] imageToImage: only first image is used (${opts.inputs.length} given)`)
    }
    const first = opts.inputs[0]!
    const subjectImage = await toDataUrlOrUrl(first, opts.signal)
    const body: Record<string, unknown> = {
      ...buildBody(config.model, opts),
      subject_reference: [{ type: 'character', image_file: subjectImage }],
    }
    const json = await callMinimax(() => fetchJson({
      method: 'POST',
      url: `${stripTrailingSlash(config.baseUrl)}/image_generation`,
      headers: {
        'Authorization': `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      timeoutMs: TIMEOUT_MS,
      signal: opts.signal,
    }), opts.signal, 'minimax I2I')
    return await decodeMinimaxResponse(json, opts.n ?? 1, opts.size)
  },
}

function buildBody(model: string, opts: AdapterT2IOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    response_format: 'url',
    n: opts.n ?? 1,
  }
  if (opts.size !== undefined) {
    // "1024x1024" / "16:9" 都尝试;若不是 aspect ratio 形式则用 width/height
    if (/^\d+\s*:\s*\d+$/.test(opts.size)) {
      body.aspect_ratio = opts.size.replace(/\s/g, '')
    } else {
      const m = opts.size.match(/^(\d+)\s*[xX*]\s*(\d+)$/)
      if (m) {
        body.width = Number(m[1])
        body.height = Number(m[2])
      }
    }
  }
  if (opts.seed !== undefined) body.seed = opts.seed
  return body
}

async function toDataUrlOrUrl(input: ProviderInputImage, _signal: AbortSignal | undefined): Promise<string> {
  if (input.kind === 'url') return input.url
  // bytes → data URL
  const mediaType = input.mediaType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
  return `data:${mediaType};base64,${encodeBase64(input.bytes)}`
}

async function decodeMinimaxResponse(
  json: unknown,
  n: number,
  size?: string,
): Promise<GeneratedImage[]> {
  const obj = json as {
    data?: { image_urls?: string[]; image_base64?: string[] }
    metadata?: { success_count?: number; failed_count?: number }
  }
  const urls = obj.data?.image_urls ?? []
  const b64s = obj.data?.image_base64 ?? []
  if (urls.length === 0 && b64s.length === 0) {
    throw new Error(`minimax: empty response: ${JSON.stringify(json).slice(0, 200)}`)
  }
  const fallbackDim = parseSize(size ?? '1024x1024')
  const results: GeneratedImage[] = []
  for (const u of urls) {
    const bytes = await downloadBytes(u)
    results.push({ bytes, mediaType: 'image/jpeg', width: fallbackDim?.w ?? 1024, height: fallbackDim?.h ?? 1024, sourceUrl: u })
  }
  for (const b of b64s) {
    const bytes = decodeBase64(b)
    results.push({ bytes, mediaType: 'image/jpeg', width: fallbackDim?.w ?? 1024, height: fallbackDim?.h ?? 1024 })
  }
  if (results.length !== n && n > 1) {
    console.warn(`[image-gen:minimax] requested n=${n}, got ${results.length}`)
  }
  return results
}

async function callMinimax(
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
        lastError = new Error(`${label}: HTTP ${res.status} ${res.statusText}`)
        continue
      }
      if (res.status === 401) {
        throw new Error(`${label}: 鉴权失败 (HTTP 401) — 请检查 MiniMax API key`)
      }
      if (!res.status.toString().startsWith('2')) {
        const errObj = (res.json ?? {}) as { base_resp?: { status_code?: number; status_msg?: string } }
        const code = errObj.base_resp?.status_code
        const msg = code !== undefined && ERROR_CODE_MESSAGES[code]
          ? `${code} ${ERROR_CODE_MESSAGES[code]}`
          : `${res.status} ${res.statusText}: ${truncate(res.json)}`
        throw new Error(`${label}: ${msg}`)
      }
      // 2xx 也要看 base_resp.status_code,可能含业务错误。
      const errObj = (res.json ?? {}) as { base_resp?: { status_code?: number; status_msg?: string } }
      const code = errObj.base_resp?.status_code
      if (code !== undefined && code !== 0) {
        const msg = ERROR_CODE_MESSAGES[code] ?? errObj.base_resp?.status_msg ?? `unknown error code ${code}`
        throw new Error(`${label}: ${code} ${msg}`)
      }
      return res.json
    } catch (err) {
      if (isRetryableFetchError(err)) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (signal?.aborted) throw lastError
        continue
      }
      throw err
    }
  }
  throw lastError ?? new Error(`${label}: failed after retries`)
}

function parseSize(s: string): { w: number; h: number } | null {
  const m = s.match(/^(\d+)\s*[xX*]\s*(\d+)$/)
  if (!m) return null
  return { w: Number(m[1]), h: Number(m[2]) }
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

function truncate(v: unknown, max = 300): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? s.slice(0, max) + '…' : s
}
