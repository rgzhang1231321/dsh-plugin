/**
 * 加载并热监听 `image-gen` 的本地 JSON 配置文件。
 *
 * 用途:用户给的 settings UI 入口在当前 web client 找不到,这里用本地 JSON
 * 替代,直接 patch 进 `SettingsScope` 的 user 层,行为等同在 UI 里改。
 *
 * 路径查找顺序(首个存在的就用):
 *   1. `<cwd>/image-gen.json`                              — 项目级配置,推荐
 *   2. `~/.dsh/image-gen.json`                              — 用户级兜底
 *   3. 都没有 → 不加载,只走 settings 的 base 默认值
 *
 * JSON 形状 = `ImageGenSettings`(只填想覆盖的字段即可;其他继承 base 默认)。
 * 例:
 *   {
 *     "defaultProvider": "minimax",
 *     "providers": {
 *       "minimax": { "enabled": true, "apiKey": "sk-cp-…", "baseUrl": "https://api.minimaxi.com/v1", "model": "image-01" }
 *     }
 *   }
 *
 * 热加载:用 `fs.watch` 监听文件,变更时重新读 + 校验 + 触发 onChange。读失败
 * (语法错 / 字段类型错)仅 console.warn,不抛,避免一次手滑把插件搞瘫。
 */

import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ImageGenSettings } from './settings'

export type LoadedConfig = Partial<ImageGenSettings>

export type ConfigFilePathResolver = (cwd: string) => string[]

/**
 * 解析配置文件候选路径(由近到远):cwd 优先,再回落到用户家目录。
 * 测试可注入自己的 resolver。
 */
export function defaultConfigFilePaths(cwd: string): string[] {
  return [
    join(cwd, 'image-gen.json'),
    join(homedir(), '.dsh', 'image-gen.json'),
  ]
}

/** 给定路径列表,返回第一个存在且是文件的路径;都找不到返回 null。 */
export function findConfigFile(cwd: string, resolver: ConfigFilePathResolver = defaultConfigFilePaths): string | null {
  for (const p of resolver(cwd)) {
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 读 + 解析 + 浅校验一份配置文件。返回:
 *   - `{ ok: true, data }` 成功
 *   - `{ ok: false, error }` 失败(error 是给 console.warn 用的人话)
 *
 * 不做完整 schema 校验(完整校验由 SettingsScope.replace 内部完成);
 * 这里只保证 JSON 解析通 + 顶层是 plain object。
 */
export function loadConfigFile(path: string): { ok: true; data: LoadedConfig } | { ok: false; error: string } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return { ok: false, error: `read failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (raw.trim() === '') {
    return { ok: true, data: {} }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { ok: false, error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'top-level value must be a JSON object' }
  }
  return { ok: true, data: parsed as LoadedConfig }
}

export interface ConfigWatcher {
  /** 当前正在生效的配置路径(可能为 null — 没找到文件)。 */
  readonly path: string | null
  /** 停监听,释放 fs watcher。 */
  close(): void
}

/**
 * 启动一个 fs.watch 监听指定配置文件。文件被改时:
 *   1. 重新读 + parse;
 *   2. 调 onChange(data) — 调用方负责把 data 写进 SettingsScope。
 *
 * 文件被删 → 静默停 watch(不报错),等下次手工重启插件。
 * debounce 200ms:避免编辑器保存时多次 IN_CLOSE_WRITE 抖动。
 */
export function startConfigWatcher(
  path: string,
  onChange: (data: LoadedConfig) => void | Promise<void>,
): ConfigWatcher {
  let timer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let watcher: FSWatcher | null = null

  const fire = (): void => {
    if (closed) return
    const res = loadConfigFile(path)
    if (!res.ok) {
      console.warn(`[image-gen:config] ${path}: ${res.error}`)
      return
    }
    try {
      const r = onChange(res.data)
      if (r && typeof (r as Promise<unknown>).then === 'function') {
        (r as Promise<unknown>).catch((err: unknown) => {
          console.warn(`[image-gen:config] onChange rejected: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
    } catch (err) {
      console.warn(`[image-gen:config] onChange threw: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const debounced = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fire, 200)
  }

  try {
    watcher = watch(path, { persistent: false }, () => debounced())
  } catch (err) {
    console.warn(`[image-gen:config] failed to watch ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    get path() { return path },
    close() {
      if (closed) return
      closed = true
      if (timer) clearTimeout(timer)
      try { watcher?.close() } catch { /* ignore */ }
    },
  }
}

/**
 * 把"用户给的 LoadedConfig 浅片"标准化成完整的 ImageGenSettings 形状,
 * 供 SettingsScope.replace 使用。缺失字段补成 settings 的 BASE 默认值。
 * BASE 不会引用,避免循环依赖;直接传 baseByKey。
 */
export function mergeConfigWithBase(
  loaded: LoadedConfig,
  base: ImageGenSettings,
): ImageGenSettings {
  return {
    defaultProvider: loaded.defaultProvider ?? base.defaultProvider,
    defaultSize: loaded.defaultSize ?? base.defaultSize,
    defaultN: loaded.defaultN ?? base.defaultN,
    pollTimeoutMs: loaded.pollTimeoutMs ?? base.pollTimeoutMs,
    bailianEditModel: loaded.bailianEditModel ?? base.bailianEditModel,
    providers: {
      openai: { ...base.providers.openai, ...(loaded.providers?.openai ?? {}) },
      bailian: { ...base.providers.bailian, ...(loaded.providers?.bailian ?? {}) },
      minimax: { ...base.providers.minimax, ...(loaded.providers?.minimax ?? {}) },
    },
  }
}
