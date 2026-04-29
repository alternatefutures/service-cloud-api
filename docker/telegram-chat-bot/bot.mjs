import http from 'node:http'
import https from 'node:https'

const token = process.env.TELEGRAM_BOT_TOKEN
const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'telegramchatdemobot'
const port = Number(process.env.PORT || 3000)
const projectName = process.env.PROJECT_NAME || 'Your project'
const projectContext =
  process.env.PROJECT_CONTEXT ||
  'This is a community project. Configure PROJECT_CONTEXT to explain what it does.'
const projectStatus = process.env.PROJECT_STATUS || 'Early community stage.'
const primaryLink = process.env.PRIMARY_LINK || ''
const secondaryLink = process.env.SECONDARY_LINK || ''
const communityGoal = process.env.COMMUNITY_GOAL || ''
const botPersona =
  process.env.BOT_PERSONA ||
  'Be concise, friendly, and factual. Do not make promises that are not in the configured project context.'
const guardrails =
  process.env.GUARDRAILS ||
  'Do not claim a token has launched unless PROJECT_CONTEXT or PROJECT_STATUS explicitly says so. Do not give financial advice.'

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is required')
  process.exit(1)
}

const apiBase = `https://api.telegram.org/bot${token}`
let offset = 0
let stopped = false

http.createServer((request, response) => {
  if (request.url === '/' || request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('telegram-community-bot ok\n')
    return
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('not found\n')
}).listen(port, '0.0.0.0', () => {
  console.log(`[health] listening on 0.0.0.0:${port}`)
})

async function telegram(method, body) {
  const payload = await telegramRequest(method, body)
  if (!payload?.ok) {
    throw new Error(`${method} failed: ${JSON.stringify(payload)}`)
  }
  return payload.result
}

function telegramRequest(method, body) {
  const bodyJson = JSON.stringify(body)

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/${method}`,
        method: 'POST',
        family: 4,
        timeout: 45_000,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyJson),
        },
      },
      response => {
        let raw = ''
        response.setEncoding('utf8')
        response.on('data', chunk => {
          raw += chunk
        })
        response.on('end', () => {
          try {
            resolve(JSON.parse(raw))
          } catch (error) {
            reject(new Error(`${method} returned invalid JSON: ${raw.slice(0, 200)}`))
          }
        })
      },
    )

    request.on('timeout', () => {
      request.destroy(new Error(`${method} timed out`))
    })
    request.on('error', reject)
    request.end(bodyJson)
  })
}

function mainKeyboard() {
  const rows = [
    [{ text: 'What is this?', callback_data: 'info' }],
    [{ text: 'Status', callback_data: 'status' }],
  ]

  const linkRow = []
  if (primaryLink) linkRow.push({ text: 'Primary link', url: primaryLink })
  if (secondaryLink) linkRow.push({ text: 'More info', url: secondaryLink })
  if (linkRow.length) rows.push(linkRow)

  rows.push([{ text: 'Community goal', callback_data: 'goal' }])

  return {
    inline_keyboard: rows,
  }
}

function buildIntroText() {
  const parts = [
    `${projectName}`,
    '',
    projectContext,
    '',
    `Status: ${projectStatus}`,
  ]

  if (communityGoal) {
    parts.push('', `Community goal: ${communityGoal}`)
  }

  const links = [primaryLink, secondaryLink].filter(Boolean)
  if (links.length) {
    parts.push('', `Links:\n${links.join('\n')}`)
  }

  return parts.join('\n')
}

async function postMainMenu(chatId) {
  await telegram('sendMessage', {
    chat_id: chatId,
    text: buildIntroText(),
    reply_markup: mainKeyboard(),
  })
}

async function postHelp(chatId) {
  await telegram('sendMessage', {
    chat_id: chatId,
    text: [
      `I am @${botUsername}, a community bot for ${projectName}.`,
      '',
      'Commands:',
      '/start - show project overview',
      '/status - show current project status',
      '/links - show configured links',
      '/rules - show response guardrails',
      '',
      'In groups, mention me or use commands so I do not spam the chat.',
    ].join('\n'),
  })
}

async function postStatus(chatId) {
  await telegram('sendMessage', {
    chat_id: chatId,
    text: `${projectName} status:\n${projectStatus}`,
  })
}

async function postLinks(chatId) {
  const links = [primaryLink, secondaryLink].filter(Boolean)
  await telegram('sendMessage', {
    chat_id: chatId,
    text: links.length ? links.join('\n') : 'No links configured yet.',
  })
}

async function postRules(chatId) {
  await telegram('sendMessage', {
    chat_id: chatId,
    text: [`Persona: ${botPersona}`, '', `Guardrails: ${guardrails}`].join('\n'),
  })
}

function shouldAnswer(message) {
  const chatType = message.chat?.type
  const text = message.text || ''

  if (chatType === 'private') return true
  if (text.startsWith('/')) return true
  if (text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)) return true

  return false
}

function buildAnswer(text) {
  const normalized = text.toLowerCase()

  if (normalized.includes('token')) {
    return `${projectName} status: ${projectStatus}\n\n${guardrails}`
  }

  if (normalized.includes('link') || normalized.includes('where')) {
    const links = [primaryLink, secondaryLink].filter(Boolean)
    return links.length ? links.join('\n') : 'No links configured yet.'
  }

  if (normalized.includes('status') || normalized.includes('launch')) {
    return `${projectName} status:\n${projectStatus}`
  }

  if (normalized.includes('goal') || normalized.includes('why')) {
    return communityGoal || projectContext
  }

  return buildIntroText()
}

async function handleMessage(message) {
  if (!shouldAnswer(message)) return

  const chatId = message.chat.id
  const text = message.text || ''
  const command = text.split(/\s+/)[0].split('@')[0].toLowerCase()

  if (command === '/help') return postHelp(chatId)
  if (command === '/status') return postStatus(chatId)
  if (command === '/links') return postLinks(chatId)
  if (command === '/rules') return postRules(chatId)
  if (command === '/start' || !text.trim()) return postMainMenu(chatId)

  await telegram('sendMessage', {
    chat_id: chatId,
    text: buildAnswer(text),
    reply_markup: mainKeyboard(),
  })
}

async function handleCallback(query) {
  const chatId = query.message?.chat?.id
  if (!chatId) return

  await telegram('answerCallbackQuery', { callback_query_id: query.id })

  if (query.data === 'info') return postMainMenu(chatId)
  if (query.data === 'status') return postStatus(chatId)
  if (query.data === 'goal') {
    return telegram('sendMessage', {
      chat_id: chatId,
      text: communityGoal || 'No community goal configured yet.',
    })
  }

  await telegram('sendMessage', { chat_id: chatId, text: 'Unknown action.' })
}

async function poll() {
  console.log('[boot] polling for community messages.')

  while (!stopped) {
    try {
      const updates = await telegram('getUpdates', {
        offset,
        timeout: 30,
        allowed_updates: ['message', 'callback_query'],
      })

      for (const update of updates) {
        offset = update.update_id + 1
        if (update.message) {
          await handleMessage(update.message)
        }
        if (update.callback_query) {
          await handleCallback(update.callback_query)
        }
      }
    } catch (error) {
      console.error('[poll] error', error)
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  }
}

process.on('SIGTERM', () => {
  stopped = true
})
process.on('SIGINT', () => {
  stopped = true
})

poll()
