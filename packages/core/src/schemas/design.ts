import { z } from 'zod'

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
/** Data-only mockups: no generated scripts, HTML, or remote assets are rendered. */
export const DesignOption = z.object({
  id: z.enum(['a', 'b', 'c']),
  name: z.string().min(1).max(60),
  summary: z.string().min(1).max(300),
  tradeoff: z.string().min(1).max(240),
  instructions: z.string().min(1).max(5000),
  mockup: z.object({
    layout: z.enum(['sidebar', 'topbar', 'split']),
    palette: z.object({ background: color, surface: color, ink: color, accent: color }),
    typography: z.enum(['sans', 'serif', 'mono']),
    corners: z.enum(['square', 'soft', 'round']),
    appName: z.string().min(1).max(40),
    title: z.string().min(1).max(60),
    subtitle: z.string().max(100),
    navigation: z.array(z.string().min(1).max(24)).min(2).max(4),
    action: z.string().min(1).max(30),
    items: z
      .array(z.object({ title: z.string().min(1).max(50), detail: z.string().max(90) }))
      .min(3)
      .max(4),
  }),
})
export type DesignOption = z.infer<typeof DesignOption>
export const DesignOptions = z
  .array(DesignOption)
  .length(3)
  .superRefine((options, ctx) => {
    if (new Set(options.map((o) => o.id)).size !== 3)
      ctx.addIssue({ code: 'custom', message: 'Provide options A, B, and C exactly once.' })
    if (new Set(options.map((o) => o.mockup.layout)).size !== 3)
      ctx.addIssue({
        code: 'custom',
        message: 'Use three different layouts, not just different colors.',
      })
  })
export const DesignReply = z.object({ text: z.string().min(1).max(2000), options: DesignOptions })
