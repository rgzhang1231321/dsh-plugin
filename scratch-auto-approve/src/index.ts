import type { Context } from '@deepseek-ai/cordis'
// 下面两个 import 不取任何值,只为触发模块增强 — dsh-tools / dsh-user-approval
// 各自往 `@deepseek-ai/cordis` 的 `Events` 接口里塞了 `tools/pre-execute` 和
// `approval/request`,没有这行 import 这些 key 在 ctx.on() 上就不可见。
import '@deepseek-ai/dsh-tools'
import '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { resolveConfig, type Config } from './config'
import { evaluateCommand } from './policy'

/**
 * 插件名 — 必须与 `cordis.yml` 里的 `id:` 一致,loader 才会把它作为同一
 * 个插件的 entry 处理(同一个 entry 多次 apply 会先 dispose 再 apply,
 * 所以 HMR 时注册的两个监听器会被一并清掉重新挂上,不会泄漏)。
 */
export const name = 'auto-approve'

/**
 * 我们要用 `ctx.approval` 的事件总线,以及 `ctx.on('tools/pre-execute', ...)`
 * 的事件总线;`approval` 注入以保证 service 已就绪,`tools` 是 ctx.on 的隐式
 * 依赖(cordis 事件总线默认在所有插件上可用),但显式声明 inject 便于文档化。
 */
export const inject = ['approval', 'tools'] as const

/**
 * 入口:挂两个监听器。
 *
 * 1. `approval/request` — 直接返回 `'allowed-once'`,让所有走到 approval 缝的
 *    问题都不再弹窗。Harness 的工具栈里,凡是会询问"你能跑这个吗?"的代码
 *    都走这条缝(bash 沙箱提权、子代理问询等)。
 *
 * 2. `tools/pre-execute` — 在工具真正派发前看一眼参数,如果是 bash 类工具且
 *    命令含删除关键词,且目标路径不在 workspace 内,直接返回 `deny`。
 *    这一层是"删错地方就拦下",与第一层的"问就放行"是两条独立的策略。
 */
export function apply(ctx: Context, config?: Config): void {
  const cfg = resolveConfig(config)

  ctx.logger.warn(
    '[auto-approve] loaded: all approval requests will be auto-allowed.'
    + (cfg.enforceWorkspaceBoundary
      ? ` Deletion targets outside ${cfg.workspace} will be denied.`
      : ' Workspace boundary check is DISABLED.'),
  )

  // 1. 自动批准 answerer。
  ctx.on('approval/request', (request) => {
    ctx.logger.debug?.(
      '[auto-approve] allowing %s (reason: %s)',
      request.toolName,
      request.reason ?? '<none>',
    )
    const outcome: ApprovalOutcome = 'allowed-once'
    return Promise.resolve(outcome)
  })

  // 2. 工作区边界 gate。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const verdict = evaluateCommand(
      exec.name,
      exec.arguments,
      cfg.workspace,
      cfg.enforceWorkspaceBoundary,
      cfg.allowOutsideWorkspace,
    )
    if (verdict.decision === 'deny') {
      ctx.logger.warn('[auto-approve] DENY %s — %s', exec.name, verdict.reason)
      return { kind: 'deny', reason: verdict.reason ?? 'denied by auto-approve policy' }
    }
    return next()
  })
}
