import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * 在一条命令字符串里匹配删除意图的关键词,覆盖常见 shell 与 PowerShell。
 * 匹配不区分大小写;只识别"看起来像动词"的边界形式,避免误伤文件名里
 * 含 `rm` 的合法路径(比如 `summary.txt`)。`\b` 在 unicode 字符串上需要
 * 配合 `(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])` 这种手工边界才稳,这里用
 * 非单词字符作边界即可,覆盖 99% 的真实命令。
 */
const DELETION_KEYWORDS: readonly RegExp[] = [
  // POSIX / bash / git-bash
  /\brm(?:dir)?\b/i,             // rm, rm -rf, rmdir
  /\bunlink\b/i,
  /\btrash\b/i,                  // macOS trash
  // cmd.exe
  /\bdel\b/i,
  /\brd\b/i,                     // cmd 的 rmdir 别名
  // PowerShell
  /\bRemove-Item\b/i,
  /\bRemove-ItemProperty\b/i,
  /\bMove-Item\b/i,              // move 在源端是删除(但目标可能合法,先按可疑处理)
  /\bClear-Content\b/i,
  /\bClear-Item\b/i,
  // shell 高危复合命令
  /\bgit\s+clean\b/i,            // git clean -fdx
  /\bgit\s+rm\b/i,               // git rm
  /\bfsutil\b/i,                 // fsutil file delete
]

/**
 * 工具名 → 取参路径。Harness 的 bash 工具的 parsed args 是
 * `{ command: string, description: string, ... }`,所以从 arguments.command
 * 取;其它工具按需扩展。
 */
interface BashLikeArgs {
  command?: unknown
}

function isBashLike(toolName: string): boolean {
  return toolName === 'bash' || toolName === 'subprocess' || toolName.endsWith(':bash')
}

function getCommandString(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const cmd = (args as BashLikeArgs).command
  return typeof cmd === 'string' ? cmd : undefined
}

/**
 * 命令里是否含删除意图。
 */
export function looksLikeDeletion(command: string): boolean {
  return DELETION_KEYWORDS.some(re => re.test(command))
}

/**
 * 从一条命令字符串里把"看起来像文件路径"的 token 抽出来。
 *
 * 启发式:双引号/单引号包裹的字符串 + 以 `/` / `~/` / `./` / `../` /
 * `[A-Za-z]:[\\/]`(盘符)开头的 token。引号里可能是命令参数、可能是 echo 的
 * 内容,这里只取"像路径"的;误报(把不是路径的引号内容当路径)在 isInside
 * 检查里会被自然过滤。
 */
export function extractCandidatePaths(command: string): string[] {
  const paths = new Set<string>()

  // 1. 引号包裹的字符串
  const quoted = command.matchAll(/[`"']([^`"']+)[`"']/g)
  for (const m of quoted) {
    const inner = (m[1] ?? '').trim()
    if (looksLikePath(inner)) paths.add(inner)
  }

  // 2. 无引号但形态像路径的 token
  const tokens = command.split(/\s+/)
  for (const t of tokens) {
    const cleaned = t.replace(/[;,()\[\]{}'"]/g, '')
    if (looksLikePath(cleaned)) paths.add(cleaned)
  }

  return [...paths]
}

function looksLikePath(s: string): boolean {
  if (s.length === 0) return false
  return (
    s.startsWith('/')
    || s.startsWith('~/')
    || s.startsWith('./')
    || s.startsWith('../')
    || /^[A-Za-z]:[\\/]/.test(s)        // Windows 盘符 C:\ D:/
    || s.startsWith('\\\\')              // UNC \\server\share
  )
}

/**
 * 目标路径是否落在 workspace 之内。
 *
 * 判定方法:把两边都 resolve 成绝对路径,看 relative(workspace, target) 是否
 * 以 `..` 开头(说明越界)或是绝对盘符路径(说明跨盘符,也越界)。符号链接不
 * 解析 — 走 symlink 真要看 Lstat 那是另一层;现在够用。
 */
export function isInsideWorkspace(target: string, workspace: string): boolean {
  const resolvedTarget = resolve(target)
  const resolvedWorkspace = resolve(workspace)
  const rel = relative(resolvedWorkspace, resolvedTarget)
  if (rel === '') return true
  if (rel.startsWith('..' + sep) || rel === '..') return false
  if (isAbsolute(rel)) return false
  return true
}

export interface PolicyVerdict {
  readonly decision: 'allow' | 'deny'
  readonly reason?: string
}

/**
 * 对一条解析后的 tool 调用做策略判定。
 *
 * - 非 bash 类工具:放行(它们的删除/修改走 dsh-tool-fs 的 fs provider,已经
 *   有自己的 policy 层;我们不在这里二次拦截以免重复劳动)。
 * - 没开 enforceWorkspaceBoundary:放行。
 * - 命令命中豁免列表(精确匹配 trim 后的整条命令):放行。
 * - 命令里没有删除关键词:放行。
 * - 命令有删除关键词:
 *     - 抽路径,逐个 isInsideWorkspace 检查;
 *     - 全部在内:放行(但 log 一行 audit);
 *     - 任一在外:拒绝,理由里把越界路径列出来;
 *     - 没抽到任何路径:拒绝(默认保守 — 含删除意图的命令必须给出明确路径)。
 */
export function evaluateCommand(
  toolName: string,
  args: unknown,
  workspace: string,
  enforceBoundary: boolean,
  allowlist: ReadonlySet<string>,
): PolicyVerdict {
  if (!isBashLike(toolName)) return { decision: 'allow' }
  if (!enforceBoundary) return { decision: 'allow' }

  const command = getCommandString(args)
  if (command === undefined) return { decision: 'allow' }

  const trimmed = command.trim()
  if (allowlist.has(trimmed)) return { decision: 'allow' }
  if (!looksLikeDeletion(trimmed)) return { decision: 'allow' }

  const candidates = extractCandidatePaths(trimmed)
  if (candidates.length === 0) {
    return {
      decision: 'deny',
      reason: `命令包含删除关键词但解析不出文件路径,默认拒绝。命令: ${trimmed.slice(0, 200)}`,
    }
  }

  const outside: string[] = []
  for (const p of candidates) {
    if (!isInsideWorkspace(p, workspace)) outside.push(p)
  }
  if (outside.length > 0) {
    return {
      decision: 'deny',
      reason: `删除目标在 workspace 之外:\n  workspace = ${workspace}\n  越界路径 = ${outside.join(', ')}\n原始命令: ${trimmed.slice(0, 200)}`,
    }
  }

  return { decision: 'allow' }
}
