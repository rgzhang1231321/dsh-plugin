/**
 * `image-gen` scratch 插件入口。
 *
 * 加载顺序(由 cordis 拓扑保证):
 *   1. settings  — 注册 `image-gen` 命名空间,tool 之后要读。
 *   2. tools     — 注册 `image-gen` tool。
 *   3. logger    — 打 ready 日志。
 *
 * `inject` 只列依赖,不强制顺序;顶层 await 由 cordis 处理。
 *
 * 配置加载:本插件支持一份本地 JSON 配置文件(替代 settings UI),路径:
 *   1. `<cwd>/image-gen.json`  — 项目级,推荐
 *   2. `~/.dsh/image-gen.json` — 用户级
 * 启动时读一次 → 合并到 BASE → 写进 SettingsScope.user 层;之后
 * `fs.watch` 监听热加载,改动即触发 settings.replace,不需要重启 web。
 */

import { cwd as processCwd } from 'node:process'
import type { Context } from '@deepseek-ai/cordis'
import { IMAGE_GEN_BASE, registerSettings } from './settings'
import {
  findConfigFile,
  loadConfigFile,
  mergeConfigWithBase,
  startConfigWatcher,
  type ConfigWatcher,
  type LoadedConfig,
} from './config-file'
import { registerImageGenTool } from './tools/image-gen'

export const name = 'image-gen'

export const inject = [
  'settings',
  'tools',
] as const

let configWatcher: ConfigWatcher | null = null

export async function apply(ctx: Context): Promise<void> {
  console.log('[image-gen] apply() called')
  ctx.logger.info?.('[image-gen] loading…')
  const scope = registerSettings(ctx)
  registerImageGenTool(ctx, scope)

  // 加载本地 JSON 配置文件(若存在),并启动 hot-reload watcher。
  const cwd = processCwd()
  const configPath = findConfigFile(cwd)
  if (configPath !== null) {
    console.log(`[image-gen] config file: ${configPath}`)
    ctx.logger.info?.(`[image-gen] config file: ${configPath}`)
    const applyConfig = async (data: LoadedConfig): Promise<void> => {
      const merged = mergeConfigWithBase(data, IMAGE_GEN_BASE)
      try {
        await scope.replace(merged as object)
        const enabled = Object.entries(merged.providers)
          .filter(([, cfg]) => cfg.enabled && cfg.apiKey.length > 0)
          .map(([k]) => k)
        console.log(`[image-gen] config applied: providers=${enabled.length > 0 ? enabled.join(',') : 'none-configured'}`)
        ctx.logger.info?.(
          `[image-gen] config applied: providers=${enabled.length > 0 ? enabled.join(',') : 'none-configured'}`,
        )
      } catch (err) {
        console.warn(`[image-gen] settings.replace failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 首次加载。
    const initial = loadConfigFile(configPath)
    if (initial.ok) {
      await applyConfig(initial.data)
    } else {
      console.warn(`[image-gen:config] ${configPath}: ${initial.error}`)
    }

    // 启动 fs.watch;文件改动 → 重新读 + replace。
    configWatcher = startConfigWatcher(configPath, (data) => applyConfig(data))
  } else {
    console.log('[image-gen] no config file found; using settings base defaults')
    ctx.logger.info?.('[image-gen] no config file found; using settings base defaults')
  }

  const settings = scope.get()
  const enabledProviders = Object.entries(settings.providers)
    .filter(([, cfg]) => cfg.enabled && cfg.apiKey.length > 0)
    .map(([k]) => k)
  const readyMsg = `[image-gen] ready: tool=image-gen providers=${enabledProviders.length > 0 ? enabledProviders.join(',') : 'none-configured'}`
  console.log(readyMsg)
  ctx.logger.info?.(readyMsg)
}

/** Cordis 卸载时清 watcher。 */
export function dispose(): void {
  try { configWatcher?.close() } catch { /* ignore */ }
  configWatcher = null
}
