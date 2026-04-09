import { GraphQLError } from 'graphql'
import type { Context } from './types.js'

const DISCORD_WEBHOOK_URL = process.env.DISCORD_FEEDBACK_WEBHOOK_URL

export interface SubmitFeedbackInput {
  title: string
  category: 'BUG' | 'FEEDBACK' | 'FEATURE_REQUEST'
  location?: string
  description: string
}

const CATEGORY_META: Record<string, { emoji: string; color: number }> = {
  BUG: { emoji: '🐛', color: 0xef4444 },
  FEEDBACK: { emoji: '💬', color: 0x3b82f6 },
  FEATURE_REQUEST: { emoji: '✨', color: 0x8b5cf6 },
}

async function postToDiscord(
  report: { title: string; category: string; location?: string | null; description: string; createdAt: Date },
  user: { email?: string | null; username?: string | null },
) {
  if (!DISCORD_WEBHOOK_URL) return

  const meta = CATEGORY_META[report.category] ?? { emoji: '📝', color: 0x6b7280 }

  const embed = {
    title: `${meta.emoji} [${report.category.replace('_', ' ')}] ${report.title}`,
    description:
      report.description.length > 2000
        ? report.description.slice(0, 1997) + '...'
        : report.description,
    color: meta.color,
    fields: [
      {
        name: 'User',
        value: user.username ?? user.email ?? 'unknown',
        inline: true,
      },
      ...(user.email ? [{ name: 'Email', value: user.email, inline: true }] : []),
      ...(report.location ? [{ name: 'Location', value: report.location, inline: false }] : []),
    ],
    timestamp: report.createdAt.toISOString(),
    footer: { text: 'Alternate Clouds Feedback' },
  }

  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    })
  } catch (err) {
    console.error('[feedback] Discord webhook failed:', err)
  }
}

export const feedbackMutations = {
  submitFeedback: async (
    _: unknown,
    { input }: { input: SubmitFeedbackInput },
    context: Context,
  ) => {
    if (!context.userId) {
      throw new GraphQLError('Authentication required')
    }

    const report = await context.prisma.feedbackReport.create({
      data: {
        userId: context.userId,
        title: input.title,
        category: input.category,
        location: input.location ?? null,
        description: input.description,
      },
      include: { user: true },
    })

    // Fire-and-forget — don't block the response on Discord delivery
    postToDiscord(report, report.user)

    return report
  },
}
