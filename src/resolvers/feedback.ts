import { GraphQLError } from 'graphql'
import type { Context } from './types.js'

const DISCORD_WEBHOOK_URL = process.env.DISCORD_FEEDBACK_WEBHOOK_URL
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL

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

async function fetchUserFromAuth(
  token: string,
): Promise<{ email?: string; displayName?: string }> {
  if (!AUTH_SERVICE_URL) return {}

  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/account/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return {}
    const data = (await res.json()) as {
      email?: string
      displayName?: string
    }
    return { email: data.email, displayName: data.displayName }
  } catch {
    return {}
  }
}

async function postToDiscord(
  report: {
    title: string
    category: string
    location?: string | null
    description: string
    createdAt: Date
  },
  user: { email?: string | null; displayName?: string | null },
) {
  if (!DISCORD_WEBHOOK_URL) return

  const meta = CATEGORY_META[report.category] ?? {
    emoji: '📝',
    color: 0x6b7280,
  }

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
        value: user.displayName ?? user.email ?? 'unknown',
        inline: true,
      },
      ...(user.email
        ? [{ name: 'Email', value: user.email, inline: true }]
        : []),
      ...(report.location
        ? [{ name: 'Location', value: report.location, inline: false }]
        : []),
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

    const title = input.title.trim()
    const description = input.description.trim()
    const location = input.location?.trim() || null

    if (!title || title.length > 200) {
      throw new GraphQLError(
        'Title is required and must be 200 characters or less',
      )
    }
    if (!description || description.length > 10000) {
      throw new GraphQLError(
        'Description is required and must be 10,000 characters or less',
      )
    }
    if (location && location.length > 500) {
      throw new GraphQLError('Location must be 500 characters or less')
    }

    const userAgent = context.request?.headers?.get('user-agent') ?? null
    const authToken =
      context.request?.headers?.get('authorization')?.replace('Bearer ', '') ??
      ''

    const [report, authUser] = await Promise.all([
      context.prisma.feedbackReport.create({
        data: {
          userId: context.userId,
          title,
          category: input.category,
          location,
          description,
          userAgent,
        },
      }),
      fetchUserFromAuth(authToken),
    ])

    postToDiscord(report, authUser)

    return report
  },
}
