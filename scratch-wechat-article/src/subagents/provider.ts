import type {
  ContinuableCreateSpec,
  ResolvedSubagentStartRequest,
  SubagentCapabilities,
  SubagentProvider,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'


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
