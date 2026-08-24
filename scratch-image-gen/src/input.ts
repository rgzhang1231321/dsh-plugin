/**
 * 输入图解析:把 tool 收到的"原始字符串"规范化成 ProviderInputImage。
 *
 * 解析规则(顺序匹配,首条命中即用):
 * 1. `https?://` → URL,直接交给 provider(若 provider 接受 url)。
 * 2. `file://` URL → 去掉 scheme,按本地路径读。
 * 3. 绝对路径(`/` 开头,或 Windows `C:\` `D:\` 等)→ 本地读字节。
 * 4. 相对路径 → 相对 cwd 解析,读字节。
 * 5. 其他形式 → 抛错,提示应传 URL 或本地路径。
 *
 * 备注:不支持 attachment ID — attachment ID 是品牌化字符串且没有可识别前缀,
 * 在 model prompt 里出现时无法稳定区分,留待用户显式 attachment API 调用。
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ProviderInputImage, UserImageInput } from './types'

/** 仅做"分类"——不读文件、不下 URL,留到调用方需要时再做。 */
export function classifyInput(raw: string): UserImageInput {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error('image input is empty')
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: 'url', url: trimmed }
  }
  if (/^file:\/\//i.test(trimmed)) {
    const path = fileUrlToPath(trimmed)
    return { kind: 'file-path', path }
  }
  // 绝对路径(Posix 或 Windows)。
  if (isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return { kind: 'file-path', path: trimmed }
  }
  throw new Error(
    `unsupported image input: "${trimmed}". ` +
    `Use an http(s):// URL, a file:// URL, or an absolute path.`,
  )
}

/**
 * 把单条 user input 解析成 provider 可用的形态。
 *
 * - provider `acceptsInputKind === 'url-only'`:必须是 URL;否则报错。
 *   Bailian I2I 的 `base_image_url` 协议就是这约束。
 * - provider `acceptsInputKind === 'bytes-or-url'`:本地路径读字节,URL 原样转发。
 *   OpenAI /v1/images/edits 用 multipart,接收 bytes;MiniMax 的 I2I 把 bytes 包成 data URL。
 */
export async function resolveInput(
  raw: string,
  _ctx: Context,
  _signal: AbortSignal | undefined,
  providerAccepts: 'bytes-or-url' | 'url-only',
  cwd: string,
): Promise<ProviderInputImage> {
  const classified = classifyInput(raw)

  if (classified.kind === 'url') {
    // URL 永远可转给 provider (provider 会自己 fetch 或直接用)。
    return { kind: 'url', url: classified.url }
  }

  // 以下是 file-path 分支。
  if (providerAccepts === 'url-only') {
    throw new Error(
      `Bailian image-to-image requires a public HTTPS URL; got local path "${classified.path}". ` +
      `Upload the image somewhere reachable (e.g. a CDN) and pass that URL.`,
    )
  }

  const abs = isAbsolute(classified.path) ? classified.path : resolve(cwd, classified.path)
  const bytes = await readFile(abs)
  // 简单嗅探 PNG / JPEG;其他当 png(OpenAI 会拒但错误信息更明确)。
  const mediaType = sniffPngOrJpeg(bytes)
  return { kind: 'bytes', bytes: new Uint8Array(bytes), mediaType }
}

/** 从 file:// URL 取出 path(简单实现,不支持含空格的 URL 编码但够用)。 */
function fileUrlToPath(url: string): string {
  const withoutScheme = url.replace(/^file:\/\//i, '')
  // Windows 风格 `file:///D:/foo` → `D:/foo`。
  if (/^\/[a-zA-Z]:/.test(withoutScheme)) {
    return withoutScheme.slice(1)
  }
  return decodeURIComponent(withoutScheme)
}

function sniffPngOrJpeg(bytes: Uint8Array): 'image/png' | 'image/jpeg' {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  // 默认按 PNG 处理(provider 会拒;给清晰错误信息)。
  return 'image/png'
}
