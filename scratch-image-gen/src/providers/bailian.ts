/**
 * Aliyun Bailian (DashScope) 适配。
 *
 * 协议特点:
 * 1. 必须 `Authorization: Bearer <apiKey>` + `X-DashScope-Async: enable`;
 *    缺 async 头会报"current user api does not support synchronous calls"。
 * 2. T2I 走 `/api/v1/services/aigc/text2image/image-synthesis`,I2I 走 `/api/v1/services/aigc/image2image/image-synthesis`。
 * 3. **异步** — 提交返回 task_id,轮询 `GET /api/v1/tasks/{id}`。
 * 4. 输入图仅接受公网 HTTPS URL(I2I 的 `base_image_url`),不接受本地路径或 base64。
 *    这点由 dispatcher 在调本适配器之前保证。
 * 5. 输出始终是 URL(24h 过期),本地下载成 bytes 后再返回。
 */

import { normalizeSizeForProvider } from '../settings'
import type {
  AdapterI2IOptions,
  AdapterT2IOptions,
  GeneratedImage,
  ProviderAdapter,
  ProviderConfig,
} from '../types'
import {
  downloadBytes,
  fetchJson,
  isRetryableFetchError,
  isRetryableStatus,
  sleep,
} from './base'

const SUBMIT_TIMEOUT_MS = 60_000
const POLL_BASE_INTERVAL_MS = 3_000
const POLL_BACKOFF_AFTER_MS = 30_000
const POLL_BACKOFF_INTERVAL_MS = 6_000
const MAX_RETRIES = 3
const INITIAL_BACKOFF_MS = 3_000

export interface BailianConfig extends ProviderConfig {
  /** I2I 专用模型(默认 wanx2.1-imageedit)。来自 settings.bailianEditModel。 */
  editModel: string
  /** 轮询总超时(毫秒)。 */
  pollTimeoutMs: number
}

export const bailianAdapter: ProviderAdapter = {
  id: 'bailian',
  acceptsInputKind: 'url-only',
  async textToImage(opts: AdapterT2IOptions, config: ProviderConfig): Promise<GeneratedImage[]> {
    const cfg = config as BailianConfig
    const url = `${stripTrailingSlash(cfg.baseUrl)}/api/v1/services/aigc/text2image/image-synthesis`
    const body: Record<string, unknown> = {
      model: cfg.model,
      input: { prompt: opts.prompt },
      parameters: {
        ...(opts.size !== undefined ? { size: normalizeSizeForProvider('bailian', opts.size) } : {}),
        n: opts.n ?? 1,
        ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      },
    }
    const submit = await callSubmit(() => fetchJson({
      method: 'POST',
      url,
      headers: bailianHeaders(cfg.apiKey),
      body: JSON.stringify(body),
      timeoutMs: SUBMIT_TIMEOUT_MS,
      signal: opts.signal,
    }), opts.signal, 'bailian T2I submit')
    const urls = await pollUntilDone(submit, cfg.apiKey, opts.signal, cfg.pollTimeoutMs, 'bailian T2I')
    return await downloadAll(urls, opts.signal)
  },

  async imageToImage(opts: AdapterI2IOptions, config: ProviderConfig): Promise<GeneratedImage[]> {
    const cfg = config as BailianConfig
    if (opts.inputs.length === 0) {
      throw new Error('bailian imageToImage: inputs is empty')
    }
    if (opts.inputs.length > 1) {
      console.warn(`[image-gen:bailian] imageToImage: only first image is used (${opts.inputs.length} given)`)
    }
    const first = opts.inputs[0]!
    if (first.kind !== 'url') {
      // dispatcher 应当已保证;这里是兜底防线。
      throw new Error('bailian I2I: input must be a public URL; got non-url input')
    }
    const url = `${stripTrailingSlash(cfg.baseUrl)}/api/v1/services/aigc/image2image/image-synthesis`
    const input: Record<string, unknown> = {
      function: opts.function ?? 'description_edit',
      prompt: opts.prompt,
      base_image_url: first.url,
    }
    const parameters: Record<string, unknown> = { n: opts.n ?? 1 }
    if (opts.strength !== undefined) parameters.strength = opts.strength
    const body: Record<string, unknown> = {
      model: cfg.editModel,
      input,
      parameters,
    }
    const submit = await callSubmit(() => fetchJson({
      method: 'POST',
      url,
      headers: bailianHeaders(cfg.apiKey),
      body: JSON.stringify(body),
      timeoutMs: SUBMIT_TIMEOUT_MS,
      signal: opts.signal,
    }), opts.signal, 'bailian I2I submit')
    const urls = await pollUntilDone(submit, cfg.apiKey, opts.signal, cfg.pollTimeoutMs, 'bailian I2I')
    return await downloadAll(urls, opts.signal)
  },
}

function bailianHeaders(apiKey: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'X-DashScope-Async': 'enable',
  }
}

interface SubmitResponse {
  output: { task_id: string; task_status: string }
  request_id?: string
}

interface PollResponse {
  output: {
    task_id: string
    task_status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'UNKNOWN'
    results?: Array<{ url: string }>
    task_metrics?: { TOTAL: number; SUCCEEDED: number; FAILED: number }
    code?: string
    message?: string
  }
}

async function pollUntilDone(
  submit: SubmitResponse,
  apiKey: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  label: string,
): Promise<string[]> {
  const taskId = submit.output?.task_id
  if (!taskId) {
    throw new Error(`${label}: submit response missing task_id: ${JSON.stringify(submit).slice(0, 200)}`)
  }
  const started = Date.now()
  let elapsedSinceStart = 0
  while (elapsedSinceStart < timeoutMs) {
    const wait = elapsedSinceStart < POLL_BACKOFF_AFTER_MS
      ? POLL_BASE_INTERVAL_MS
      : POLL_BACKOFF_INTERVAL_MS
    try { await sleep(wait, signal) } catch (e) { throw e instanceof Error ? e : new Error(String(e)) }
    elapsedSinceStart = Date.now() - started
    const res = await fetchJson({
      method: 'GET',
      url: `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`,
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeoutMs: 30_000,
      signal,
    })
    if (!res.status.toString().startsWith('2')) {
      console.warn(`[image-gen:bailian] poll got HTTP ${res.status}, will retry`)
      continue
    }
    const polled = res.json as PollResponse
    const status = polled.output?.task_status
    if (status === 'SUCCEEDED') {
      const urls = (polled.output.results ?? []).map(r => r.url).filter(u => typeof u === 'string')
      if (urls.length === 0) {
        throw new Error(`${label}: SUCCEEDED but no result URLs`)
      }
      return urls
    }
    if (status === 'FAILED' || status === 'CANCELED') {
      throw new Error(`${label}: task ${status}: code=${polled.output.code} message=${polled.output.message}`)
    }
    // PENDING / RUNNING / UNKNOWN:继续轮询。
  }
  throw new Error(`${label}: poll timeout after ${timeoutMs}ms (task_id=${taskId})`)
}

async function downloadAll(urls: string[], signal: AbortSignal | undefined): Promise<GeneratedImage[]> {
  const results: GeneratedImage[] = []
  for (const url of urls) {
    try {
      const bytes = await downloadBytes(url, signal)
      results.push({ bytes, mediaType: 'image/jpeg', width: 1024, height: 1024, sourceUrl: url })
    } catch (err) {
      console.warn(`[image-gen:bailian] download failed for ${url}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (results.length === 0) {
    throw new Error('bailian: failed to download any result image')
  }
  return results
}

async function callSubmit(
  op: () => Promise<{ status: number; statusText: string; json: unknown }>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<SubmitResponse> {
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
        continue
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`${label}: 鉴权失败 (HTTP ${res.status}) — 请检查 Bailian API key`)
      }
      if (!res.status.toString().startsWith('2')) {
        throw new Error(`${label}: HTTP ${res.status} ${res.statusText}: ${truncate(res.json)}`)
      }
      return res.json as SubmitResponse
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

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

function truncate(v: unknown, max = 300): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? s.slice(0, max) + '…' : s
}
