/**
 * Quick test script for Akash wallet connectivity
 * Run with: npx tsx scripts/test-akash.ts
 */

import 'dotenv/config'
import { spawn } from 'child_process'
import { join } from 'path'

const AKASH_MCP_PATH = join(process.cwd(), '..', 'akash-mcp', 'dist', 'index.js')

interface MCPResponse {
  jsonrpc: '2.0'
  id: number
  result?: {
    content: Array<{ type: string; text: string }>
  }
  error?: {
    code: number
    message: string
  }
}

async function testAkashConnection() {
  console.log('🚀 Testing Akash MCP connection...\n')
  console.log('Akash MCP path:', AKASH_MCP_PATH)
  
  // Check if mnemonic is set
  if (!process.env.AKASH_MNEMONIC) {
    console.error('❌ AKASH_MNEMONIC not set in environment')
    process.exit(1)
  }
  console.log('✅ AKASH_MNEMONIC is set\n')

  // Start the MCP process
  console.log('Starting akash-mcp subprocess...')
  const mcpProcess = spawn('node', [AKASH_MCP_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AKASH_MNEMONIC: process.env.AKASH_MNEMONIC,
      RPC_ENDPOINT: process.env.RPC_ENDPOINT || 'https://rpc.akashnet.net:443',
      GRPC_ENDPOINT: process.env.GRPC_ENDPOINT || 'https://akash-grpc.publicnode.com:443',
    },
  })

  let buffer = ''
  const pendingRequests = new Map<number, (response: MCPResponse) => void>()
  let requestId = 0

  mcpProcess.stdout?.on('data', (data: Buffer) => {
    buffer += data.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const message = JSON.parse(line) as MCPResponse
        const resolver = pendingRequests.get(message.id)
        if (resolver) {
          resolver(message)
          pendingRequests.delete(message.id)
        }
      } catch {
        console.log('[akash-mcp]', line)
      }
    }
  })

  mcpProcess.stderr?.on('data', (data: Buffer) => {
    console.error('[akash-mcp stderr]', data.toString())
  })

  const sendRequest = (method: string, params?: Record<string, unknown>): Promise<MCPResponse> => {
    return new Promise((resolve, reject) => {
      const id = ++requestId
      pendingRequests.set(id, resolve)

      const timeout = setTimeout(() => {
        pendingRequests.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, 30000)

      const request = { jsonrpc: '2.0', id, method, params }
      mcpProcess.stdin?.write(JSON.stringify(request) + '\n', (err) => {
        if (err) {
          clearTimeout(timeout)
          pendingRequests.delete(id)
          reject(err)
        }
      })

      // Wrap resolver to clear timeout
      const originalResolver = pendingRequests.get(id)!
      pendingRequests.set(id, (response) => {
        clearTimeout(timeout)
        originalResolver(response)
      })
    })
  }

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await sendRequest('tools/call', { name, arguments: args })
    if (response.error) {
      throw new Error(response.error.message)
    }
    const textContent = response.result?.content?.find(c => c.type === 'text')
    return textContent?.text
  }

  try {
    // Wait for process to start
    await new Promise(r => setTimeout(r, 2000))

    // Initialize MCP
    console.log('Initializing MCP connection...')
    const initResponse = await sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-script', version: '1.0.0' },
    })
    
    if (initResponse.error) {
      throw new Error(`MCP init failed: ${initResponse.error.message}`)
    }
    console.log('✅ MCP initialized\n')

    // Send initialized notification
    mcpProcess.stdin?.write(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }) + '\n')

    // Get account address
    console.log('Getting wallet address...')
    const addressResult = await callTool('get-akash-account-addr')
    // Parse the address (remove quotes if present)
    const address = addressResult?.replace(/"/g, '').trim() || ''
    console.log('✅ Wallet address:', address, '\n')

    // Get balances
    console.log('Getting wallet balance...')
    const balanceResult = await callTool('get-akash-balances', { address })
    console.log('✅ Balance:', balanceResult, '\n')

    console.log('🎉 All tests passed! Akash connection is working.')

  } catch (error) {
    console.error('❌ Test failed:', error)
    process.exit(1)
  } finally {
    mcpProcess.kill()
  }
}

testAkashConnection()
