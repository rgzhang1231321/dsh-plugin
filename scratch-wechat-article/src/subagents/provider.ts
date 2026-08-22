import type {
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'

/**
 * 委托给进程内驱动的薄 SubagentProvider。
 *
 * 每个 persona 一个实例。provider 通过 getter 暴露 persona 字符串,
 * 让编排工具能把它传到 SubagentStartRequest;进程内驱动会把它以
 * `deployment:persona` section 的形式装到子代理上,覆盖任何部署级别的 persona。
 *
 * 能力表面与 `subagent-spawn-in-process` 保持一致 — 因为底层用的是同一个驱动:
 * 结构化输出、深度限制、子代理独立 persona 都支持。我们不声明 tool filter,
 * 因为文章流水线的子代理应当保留 harness 的整套工具集不变。
 */
export class WechatSubagentProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    outputSchema: true,
    depthLimit: true,
    toolFilter: false,
    persona: true,
  }
  readonly inheritsParentContext = false

  constructor(readonly name: string, private readonly personaText: string) {}

  start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    return startInProcessRun(request, {})
  }

  prepareContinuable(): Promise<ContinuableCreateSpec> {
    return Promise.resolve({})
  }

  get systemPrompt(): string {
    return this.personaText
  }
}
