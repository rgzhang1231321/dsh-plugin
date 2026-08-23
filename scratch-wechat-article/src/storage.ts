import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import type { DraftRow } from './types'


export const draftsSpec = defineDomain({
  name: 'wechat_article_drafts',
  version: 1,
  tables: {
    drafts: domainTable<string, DraftRow>(
      z.object({
        id: z.int().nonnegative(),
        topic: z.string().min(1),
        style: z.string().min(1),
        outline: z.string(),
        draft: z.string(),
        titles: z.array(z.string()).min(1),
        version: z.int().positive(),
        createdAt: z.int().nonnegative(),
        updatedAt: z.int().nonnegative(),
        coverPrompt: z.string().optional(),
        coverPath: z.string().optional(),
        coverAttachmentId: z.string().optional(),
        inlineImages: z
          .array(
            z.object({
              name: z.string(),
              anchor: z.string(),
              prompt: z.string(),
              path: z.string(),
              attachmentId: z.string(),
            }),
          )
          .optional(),
      }),
    ),
  },
})

export async function openDraftsDomain(ctx: Context) {
  const domain = await ctx.storageDomain.open(draftsSpec)
  ctx.effect(() => () => domain.close(), 'wechat-article.domainClose')
  return domain.table('drafts')
}
