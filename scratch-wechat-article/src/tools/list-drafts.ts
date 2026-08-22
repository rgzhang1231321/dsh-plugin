import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { DraftRow, DraftSummary } from '../types'

interface ListDraftsArgs {
  readonly limit?: number
}

interface ListDraftsResult {
  drafts: DraftSummary[]
  total: number
}

export function registerListDraftsTool(
  ctx: Context,
  drafts: KvTable<string, DraftRow>,
): void {
  ctx.tools.register(defineTool({
    name: 'wechat-list-drafts',
    description: 'List WeChat article drafts stored by the wechat-article plugin, newest first.',
    parameters: {
      limit: {
        type: 'integer',
        description: 'Maximum number of drafts to return. Defaults to 10.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          drafts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', required: true },
                topic: { type: 'string', required: true },
                style: { type: 'string', required: true },
                version: { type: 'integer', required: true },
                createdAt: { type: 'integer', required: true },
              },
            },
          },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        if (value.drafts.length === 0) {
          return [{ type: 'text', text: 'No WeChat article drafts yet.' }]
        }
        const lines = value.drafts.map(d => {
          const ts = new Date(d.createdAt).toISOString()
          return `#${d.id} [${d.style} v${d.version}] (${ts}) ${d.topic}`
        })
        return [{
          type: 'text',
          text: `Found ${value.drafts.length} of ${value.total} drafts:\n${lines.join('\n')}`,
        }]
      },
    },
    execute(args: ListDraftsArgs) {
      const all: DraftRow[] = []
      for (const [, row] of drafts.entries()) {
        all.push(row)
      }
      all.sort((a, b) => b.createdAt - a.createdAt)
      const limit = args.limit ?? 10
      const summaries: DraftSummary[] = all.slice(0, limit).map(r => ({
        id: r.id,
        topic: r.topic,
        style: r.style,
        version: r.version,
        createdAt: r.createdAt,
      }))
      const result: ListDraftsResult = { drafts: summaries, total: all.length }
      return Promise.resolve(result)
    },
  }))
}
