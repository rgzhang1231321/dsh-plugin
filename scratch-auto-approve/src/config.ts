import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

/**
 * 插件配置。`workspace` 是删除操作必须落入的根目录,默认取 process.cwd()
 * (也就是 harness 启动时所在的工作区根)。
 *
 * `enforceWorkspaceBoundary` 是总开关:为 false 时只做自动批准,不校验路径,
 * 等于把这个安全网整个关掉。
 *
 * `allowOutsideWorkspace` 是精细豁免列表:精确匹配整条命令字符串(去前后空格),
 * 用于一些无害但会被启发式误判的合法命令(例如 `git clean -fd`)。
 */
export interface Config {
  workspace?: string
  enforceWorkspaceBoundary?: boolean
  allowOutsideWorkspace?: string[]
}

const Schema = z.object({
  workspace: z.string().default(process.cwd()),
  enforceWorkspaceBoundary: z.boolean().default(true),
  allowOutsideWorkspace: z.array(z.string()).default([]),
})

/**
 * 解析后的运行时配置:路径被 resolve 成绝对路径,布尔值有了确定的默认。
 * `apply()` 拿到的是这个形态,不必再处理 undefined。
 */
export interface ResolvedConfig {
  readonly workspace: string
  readonly enforceWorkspaceBoundary: boolean
  readonly allowOutsideWorkspace: ReadonlySet<string>
}

export function resolveConfig(input: Config | undefined): ResolvedConfig {
  const parsed = Schema(input ?? {})
  return {
    workspace: resolve(parsed.workspace),
    enforceWorkspaceBoundary: parsed.enforceWorkspaceBoundary,
    allowOutsideWorkspace: new Set(parsed.allowOutsideWorkspace.map(s => s.trim())),
  }
}
