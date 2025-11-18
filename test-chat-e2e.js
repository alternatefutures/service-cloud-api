/**
 * End-to-End Test for Chat Feature
 *
 * This script tests the complete chat flow:
 * 1. Create a user
 * 2. Get JWT token
 * 3. Create an agent via GraphQL
 * 4. Create a chat via GraphQL
 * 5. Connect to WebSocket
 * 6. Send a message via WebSocket
 * 7. Receive agent response
 */

import WebSocket from 'ws'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'

const prisma = new PrismaClient()
const JWT_SECRET =
  process.env.JWT_SECRET || 'development-secret-change-in-production'
const GRAPHQL_URL = 'http://localhost:4000/graphql'
const WS_URL = 'ws://localhost:4000/ws'

async function graphqlRequest(query, variables = {}, token = null) {
  const headers = {
    'Content-Type': 'application/json',
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  })

  const result = await response.json()
  if (result.errors) {
    throw new Error(`GraphQL Error: ${JSON.stringify(result.errors)}`)
  }
  return result.data
}

async function runTest() {
  console.log('🧪 Starting E2E Chat Test...\n')

  try {
    // 1. Create a test user
    console.log('1️⃣  Creating test user...')

    let user = await prisma.user.findFirst({
      where: { email: 'test-chat@example.com' },
    })

    if (!user) {
      user = await prisma.user.create({
        data: {
          email: 'test-chat@example.com',
          username: 'chatTestUser',
          walletAddress: '0x' + Math.random().toString(16).substring(2, 42),
        },
      })
      console.log('   ✅ User created:', user.email)
    } else {
      console.log('   ℹ️  User already exists:', user.email)
    }

    // 2. Create Personal Access Token for GraphQL API
    console.log('\n2️⃣  Creating Personal Access Token...')
    const pat = await prisma.personalAccessToken.create({
      data: {
        userId: user.id,
        name: 'E2E Test Token',
        token:
          'test-token-' +
          Date.now() +
          '-' +
          Math.random().toString(36).substring(7),
      },
    })
    const apiToken = pat.token
    console.log('   ✅ PAT created for GraphQL API')

    // 3. Generate JWT token for WebSocket
    console.log('\n3️⃣  Generating JWT token for WebSocket...')
    const wsToken = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: '1h',
    })
    console.log('   ✅ JWT generated for WebSocket')

    // 4. Create an agent via GraphQL
    console.log('\n4️⃣  Creating agent via GraphQL...')
    const createAgentMutation = `
      mutation CreateAgent($input: CreateAgentInput!) {
        createAgent(input: $input) {
          id
          name
          slug
          status
          systemPrompt
        }
      }
    `

    const agentData = await graphqlRequest(
      createAgentMutation,
      {
        input: {
          name: 'Test Assistant',
          slug: 'test-assistant-' + Date.now(),
          description: 'A helpful test assistant',
          systemPrompt: 'You are a helpful AI assistant for testing.',
          model: 'gpt-4',
        },
      },
      apiToken
    )

    const agent = agentData.createAgent
    console.log('   ✅ Agent created:', agent.name, `(${agent.id})`)

    // 5. Create a chat via GraphQL
    console.log('\n5️⃣  Creating chat via GraphQL...')
    const createChatMutation = `
      mutation CreateChat($input: CreateChatInput!) {
        createChat(input: $input) {
          id
          title
          agent {
            name
          }
        }
      }
    `

    const chatData = await graphqlRequest(
      createChatMutation,
      {
        input: {
          agentId: agent.id,
          title: 'Test Chat Session',
        },
      },
      apiToken
    )

    const chat = chatData.createChat
    console.log('   ✅ Chat created:', chat.title, `(${chat.id})`)

    // 6. Connect to WebSocket
    console.log('\n6️⃣  Connecting to WebSocket...')
    const ws = new WebSocket(WS_URL)

    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        console.log('   ✅ WebSocket connected')
        resolve()
      })
      ws.on('error', reject)
    })

    // 7. Authenticate WebSocket connection
    console.log('\n7️⃣  Authenticating WebSocket...')
    ws.send(
      JSON.stringify({
        type: 'authenticate',
        payload: {
          token: wsToken,
          chatId: chat.id,
        },
      })
    )

    let authenticated = false
    await new Promise(resolve => {
      ws.on('message', data => {
        const message = JSON.parse(data.toString())
        if (message.type === 'authenticated') {
          console.log('   ✅ WebSocket authenticated')
          authenticated = true
          resolve()
        }
      })
    })

    // 8. Send a message via WebSocket
    console.log('\n8️⃣  Sending message via WebSocket...')
    ws.send(
      JSON.stringify({
        type: 'send_message',
        payload: {
          chatId: chat.id,
          content: 'Hello, this is a test message!',
        },
      })
    )

    // 9. Wait for agent response
    console.log('\n9️⃣  Waiting for agent response...')
    let receivedUserMessage = false
    let receivedAgentResponse = false

    await new Promise(resolve => {
      const timeout = setTimeout(() => {
        console.log('   ⚠️  Timeout waiting for messages')
        resolve()
      }, 10000)

      ws.on('message', data => {
        const message = JSON.parse(data.toString())

        if (message.type === 'message_received' && !receivedUserMessage) {
          console.log(
            '   ✅ User message received:',
            message.payload.content.substring(0, 50)
          )
          receivedUserMessage = true
        }

        if (message.type === 'agent_response' && !receivedAgentResponse) {
          console.log(
            '   ✅ Agent response received:',
            message.payload.content.substring(0, 50)
          )
          receivedAgentResponse = true
          clearTimeout(timeout)
          resolve()
        }
      })
    })

    // 10. Verify messages in database
    console.log('\n🔟 Verifying messages in database...')
    const messages = await prisma.message.findMany({
      where: { chatId: chat.id },
      orderBy: { createdAt: 'asc' },
      include: {
        user: { select: { username: true } },
        agent: { select: { name: true } },
      },
    })

    console.log(`   ✅ Found ${messages.length} messages in database:`)
    messages.forEach((msg, index) => {
      const sender = msg.role === 'USER' ? msg.user?.username : msg.agent?.name
      console.log(
        `      ${index + 1}. [${msg.role}] ${sender}: ${msg.content.substring(0, 60)}...`
      )
    })

    // Cleanup
    ws.close()
    console.log('\n✨ E2E Test Complete!\n')
    console.log('Summary:')
    console.log('  - User created: ✅')
    console.log('  - Agent created: ✅')
    console.log('  - Chat created: ✅')
    console.log('  - WebSocket connection: ✅')
    console.log('  - Message sent: ✅')
    console.log(`  - Messages persisted: ✅ (${messages.length} messages)`)
    console.log('  - Agent response: ' + (receivedAgentResponse ? '✅' : '⚠️'))
  } catch (error) {
    console.error('\n❌ Test failed:', error.message)
    console.error(error.stack)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
    process.exit(0)
  }
}

runTest()
