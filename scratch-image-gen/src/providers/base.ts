/**
 * Provider adapter 公共基础:重试 sleep、HTTP fetch 包装。
 *
 * 三个 provider 都跑同步 fetch(OpenAI / MiniMax)或异步 submit+poll(Bailian),
 * 都需要"尊重 abort 信号 + 指数退避 + 分类错误"的能力,这里集中提供。
 */

/**
 * AbortSignal 是全局类型 (lib.dom / Node 18+),无需 import。
 * 运行时使用全局 `AbortSignal.timeout()` 与 `AbortSignal.any()`。
 */

/** 短 sleep,监听外部 abort。 */
export function sleep(ms: number, signal?: AbortSignal | undefined): Promise<void> {
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

/** 单次 fetch 的可重试错误分类;返回 true 表示应进入重试循环。 */
export function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.message === 'aborted') return false
  // 网络级错误 (fetch failed / DNS / 连接拒绝) 重试。
  return /fetch failed|TypeError|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(error.message)
}

export function isRetryableStatus(status: number): boolean {
  // 429 限流,5xx 服务端错误 — 都重试。
  return status === 429 || status >= 500
}

/** HTTP fetch 包装:超时 + 取消信号合并 + 错误归一。 */
export interface FetchJsonOptions {
  method: 'GET' | 'POST'
  url: string
  headers: Record<string, string>
  body?: BodyInit | undefined
  /** 总超时毫秒;会与外部 signal 合并。 */
  timeoutMs: number
  signal?: AbortSignal | undefined
}

export interface FetchJsonResult {
  status: number
  statusText: string
  json: unknown
}

export async function fetchJson(opts: FetchJsonOptions): Promise<FetchJsonResult> {
  const timeout = AbortSignal.timeout(opts.timeoutMs)
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeout])
    : timeout
  const response = await fetch(opts.url, {
    method: opts.method,
    headers: opts.headers,
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    signal,
  })
  let json: unknown = null
  const text = await response.text()
  if (text.length > 0) {
    try {
      json = JSON.parse(text)
    } catch {
      // 非 JSON 响应(部分错误页是 HTML);保留原文本到 error 路径再读。
      json = { __raw: text }
    }
  }
  return {
    status: response.status,
    statusText: response.statusText,
    json,
  }
}

/** 从 URL 下载字节(限 fetch)。用于 bailian / minimax 的"先拿到 result URL,再下载"流程。 */
export async function downloadBytes(url: string, signal?: AbortSignal | undefined): Promise<Uint8Array> {
  const timeout = AbortSignal.timeout(120_000)
  const s = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetch(url, { signal: s })
  if (!response.ok) {
    throw new Error(`download failed: HTTP ${response.status} ${response.statusText} for ${url}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

/** 标准 base64 解码(Node 全局 Buffer)。 */
export function decodeBase64(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

/** 标准 base64 编码。 */
export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}
