/**
 * Akash Deployment Orchestrator
 *
 * Spawns akash-mcp as a subprocess and communicates via MCP protocol (stdio).
 * Provides high-level deployment operations for any service type (Sites, Functions, VMs, etc.)
 * 
 * This follows the Alternate Futures ecosystem architecture where Akash is a deployment
 * target alongside IPFS/Arweave/Filecoin, and can deploy any service from the Service Registry.
 */

import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import type { PrismaClient, ServiceType } from '@prisma/client'
import { providerSelector } from './providerSelector.js'

// MCP message types
interface MCPRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

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

interface AkashToolResult<T = unknown> {
  success?: boolean
  error?: string
  [key: string]: T | boolean | string | undefined
}

export class AkashOrchestrator {
  private process: ChildProcess | null = null
  private requestId = 0
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: MCPResponse) => void
      reject: (error: Error) => void
    }
  >()
  private buffer = ''
  private initialized = false

  constructor(
    private prisma: PrismaClient,
    private akashMcpPath?: string
  ) {
    // Default path assumes akash-mcp is sibling to service-cloud-api
    this.akashMcpPath =
      akashMcpPath ||
      process.env.AKASH_MCP_PATH ||
      join(process.cwd(), '..', 'akash-mcp', 'dist', 'index.js')
  }

  /**
   * Start the akash-mcp subprocess
   */
  async start(): Promise<void> {
    if (this.process) {
      return
    }

    return new Promise((resolve, reject) => {
      console.log('[AkashOrchestrator] Starting akash-mcp...')
      console.log('[AkashOrchestrator] MCP path:', this.akashMcpPath)
      console.log(
        '[AkashOrchestrator] AKASH_MNEMONIC set:',
        !!process.env.AKASH_MNEMONIC
      )
      console.log(
        '[AkashOrchestrator] AKASH_CERT_JSON set:',
        !!process.env.AKASH_CERT_JSON
      )

      // Collect stderr so we can report the actual crash reason instead of
      // the opaque "MCP process not running" message.
      let stderrBuffer = ''
      let settled = false

      this.process = spawn('node', [this.akashMcpPath!], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Pass through Akash config from env
          AKASH_MNEMONIC: process.env.AKASH_MNEMONIC,
          AKASH_CERT_JSON: process.env.AKASH_CERT_JSON,
          RPC_ENDPOINT:
            process.env.RPC_ENDPOINT || 'https://rpc.akashnet.net:443',
          GRPC_ENDPOINT:
            process.env.GRPC_ENDPOINT ||
            'https://akash-grpc.publicnode.com:443',
        },
      })

      this.process.stdout?.on('data', (data: Buffer) => {
        this.handleStdout(data.toString())
      })

      this.process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString()
        stderrBuffer += text
        console.error('[akash-mcp stderr]', text)
      })

      this.process.on('error', err => {
        console.error('[AkashOrchestrator] Process error:', err)
        if (!settled) {
          settled = true
          reject(err)
        }
      })

      this.process.on('exit', (code, signal) => {
        console.log(
          `[AkashOrchestrator] Process exited with code: ${code}, signal: ${signal}`
        )
        this.process = null
        this.initialized = false

        // If the process exits before we finished initializing, reject with
        // the real error from stderr so callers see the actual crash reason.
        if (!settled) {
          settled = true
          const reason = stderrBuffer.trim() || `exit code ${code}`
          reject(
            new Error(
              `akash-mcp process crashed during startup: ${reason}`
            )
          )
        }
      })

      // Initialize MCP connection after giving the process time to start
      setTimeout(async () => {
        if (settled) return // already rejected by exit/error handler
        try {
          await this.initialize()
          if (!settled) {
            settled = true
            resolve()
          }
        } catch (err) {
          if (!settled) {
            settled = true
            reject(err)
          }
        }
      }, 2000) // increased from 1s to 2s to give MCP more startup time
    })
  }

  /**
   * Initialize MCP connection
   */
  private async initialize(): Promise<void> {
    // Send initialize request
    const response = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'service-cloud-api',
        version: '1.0.0',
      },
    })

    if (response.error) {
      throw new Error(`MCP init failed: ${response.error.message}`)
    }

    // Send initialized notification
    this.sendNotification('notifications/initialized', {})
    this.initialized = true
    console.log('[AkashOrchestrator] MCP connection initialized')
  }

  /**
   * Handle stdout data from akash-mcp
   */
  private handleStdout(data: string): void {
    this.buffer += data

    // Process complete JSON-RPC messages
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue

      try {
        const message = JSON.parse(line) as MCPResponse
        const pending = this.pendingRequests.get(message.id)
        if (pending) {
          pending.resolve(message)
          this.pendingRequests.delete(message.id)
        }
      } catch {
        // Not JSON, might be log output
        console.log('[akash-mcp]', line)
      }
    }
  }

  /**
   * Send MCP request and wait for response
   */
  private async sendRequest(
    method: string,
    params?: Record<string, unknown>
  ): Promise<MCPResponse> {
    if (!this.process?.stdin) {
      throw new Error('MCP process not running')
    }

    const id = ++this.requestId
    const request: MCPRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject })

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, 60000) // 60s timeout

      this.process!.stdin!.write(JSON.stringify(request) + '\n', err => {
        if (err) {
          clearTimeout(timeout)
          this.pendingRequests.delete(id)
          reject(err)
        }
      })

      // Clear timeout on response
      const original = this.pendingRequests.get(id)
      if (original) {
        this.pendingRequests.set(id, {
          resolve: value => {
            clearTimeout(timeout)
            original.resolve(value)
          },
          reject: original.reject,
        })
      }
    })
  }

  /**
   * Send MCP notification (no response expected)
   */
  private sendNotification(
    method: string,
    params?: Record<string, unknown>
  ): void {
    if (!this.process?.stdin) return

    const notification = {
      jsonrpc: '2.0',
      method,
      params,
    }

    this.process.stdin.write(JSON.stringify(notification) + '\n')
  }

  /**
   * Call an MCP tool and parse the result
   */
  private async callTool<T = unknown>(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<AkashToolResult<T>> {
    const response = await this.sendRequest('tools/call', {
      name: toolName,
      arguments: args,
    })

    if (response.error) {
      return { error: response.error.message }
    }

    const textContent = response.result?.content?.find(c => c.type === 'text')
    if (!textContent) {
      return { error: 'No text content in response' }
    }

    try {
      return JSON.parse(textContent.text) as AkashToolResult<T>
    } catch {
      return { error: textContent.text }
    }
  }

  /**
   * Get the Akash wallet address
   */
  async getAccountAddress(): Promise<string> {
    const result = await this.callTool<string>('get-akash-account-addr', {})
    if (result.error) {
      throw new Error(`Failed to get account address: ${result.error}`)
    }
    // Result is just the address string
    return (result as unknown as string) || ''
  }

  /**
   * Get wallet balances
   */
  async getBalances(
    address: string
  ): Promise<Array<{ denom: string; amount: string }>> {
    const result = await this.callTool<Array<{ denom: string; amount: string }>>(
      'get-akash-balances',
      { address }
    )
    if (result.error) {
      throw new Error(`Failed to get balances: ${result.error}`)
    }
    return (result as unknown as Array<{ denom: string; amount: string }>) || []
  }

  /**
   * Create a deployment on Akash
   */
  async createDeployment(
    rawSDL: string,
    deposit: number
  ): Promise<{ dseq: number; owner: string }> {
    console.log('[AkashOrchestrator] Calling create-deployment tool...')
    const result = await this.callTool<{ dseq: number; owner: string }>(
      'create-deployment',
      {
        rawSDL,
        deposit,
        currency: 'uakt',
      }
    )

    console.log('[AkashOrchestrator] create-deployment result:', JSON.stringify(result, null, 2))

    if (result.error || !result.success) {
      throw new Error(`Failed to create deployment: ${result.error}`)
    }

    // Validate dseq is a proper integer (block height)
    const dseq = result.dseq
    if (dseq === undefined || dseq === null) {
      throw new Error(`Failed to create deployment: No dseq returned`)
    }
    
    // Convert to integer - dseq should be a block height (positive integer)
    const dseqInt = typeof dseq === 'string' ? parseInt(dseq, 10) : Math.floor(Number(dseq))
    
    if (isNaN(dseqInt) || dseqInt <= 0) {
      throw new Error(`Failed to create deployment: Invalid dseq value: ${dseq}`)
    }

    return {
      dseq: dseqInt,
      owner: result.owner as string,
    }
  }

  /**
   * Get bids for a deployment
   */
  async getBids(
    owner: string,
    dseq: number
  ): Promise<
    Array<{
      bidId: {
        provider: string
        gseq: number
        oseq: number
      }
      price: { amount: string; denom: string }
      provider?: { hostUri?: string }
    }>
  > {
    const result = await this.callTool('get-bids', { owner, dseq })

    if (result.error) {
      throw new Error(`Failed to get bids: ${result.error}`)
    }

    // Result might be an array or a "No bids" message
    if (typeof (result as unknown) === 'string' && String(result).includes('No bids')) {
      return []
    }

    return (
      (result as unknown as Array<{
        bidId: { provider: string; gseq: number; oseq: number }
        price: { amount: string; denom: string }
        provider?: { hostUri?: string }
      }>) || []
    )
  }

  /**
   * Create a lease with a provider
   */
  async createLease(
    owner: string,
    dseq: number,
    gseq: number,
    oseq: number,
    provider: string
  ): Promise<void> {
    const result = await this.callTool('create-lease', {
      owner,
      dseq,
      gseq,
      oseq,
      provider,
    })

    if (result.error || !result.success) {
      throw new Error(`Failed to create lease: ${result.error}`)
    }
  }

  /**
   * Send manifest to provider
   */
  async sendManifest(
    sdl: string,
    owner: string,
    dseq: number,
    gseq: number,
    oseq: number,
    provider: string
  ): Promise<void> {
    const result = await this.callTool('send-manifest', {
      sdl,
      owner,
      dseq,
      gseq,
      oseq,
      provider,
    })

    if (result.error) {
      throw new Error(`Failed to send manifest: ${result.error}`)
    }
  }

  /**
   * Get service URLs from provider
   */
  async getServices(
    owner: string,
    dseq: number,
    gseq: number,
    oseq: number,
    provider: string
  ): Promise<Record<string, { uris: string[] }>> {
    const result = await this.callTool<{ services: Record<string, { uris: string[] }> }>(
      'get-services',
      {
        owner,
        dseq,
        gseq,
        oseq,
        provider,
      }
    )

    if (result.error) {
      throw new Error(`Failed to get services: ${result.error}`)
    }

    return (result as unknown as { services: Record<string, { uris: string[] }> }).services || {}
  }

  /**
   * Close a deployment
   */
  async closeDeployment(dseq: number): Promise<void> {
    const result = await this.callTool('close-deployment', { dseq })

    if (result.error || !result.success) {
      throw new Error(`Failed to close deployment: ${result.error}`)
    }
  }

  /**
   * Get deployment logs
   */
  async getLogs(
    owner: string,
    dseq: number,
    gseq: number,
    oseq: number,
    provider: string,
    service?: string,
    tail?: number
  ): Promise<string> {
    const result = await this.callTool<string>('get-logs', {
      owner,
      dseq,
      gseq,
      oseq,
      provider,
      service,
      tail: tail || 100,
    })

    if (result.error) {
      throw new Error(`Failed to get logs: ${result.error}`)
    }

    return (result as unknown as string) || ''
  }

  /**
   * Stop the akash-mcp subprocess
   */
  stop(): void {
    if (this.process) {
      this.process.kill()
      this.process = null
      this.initialized = false
    }
  }

  /**
   * Check if orchestrator is ready
   */
  isReady(): boolean {
    return this.initialized && this.process !== null
  }

  // ========================================
  // High-level deployment operations
  // ========================================

  /**
   * Deploy any service to Akash (full flow)
   * This is the primary method that handles all service types via the Service Registry.
   */
  async deployService(
    serviceId: string,
    options: {
      deposit?: number
      sdlContent?: string // Custom SDL, if not provided will be auto-generated
    } = {}
  ): Promise<string> {
    const deposit = options.deposit || 5000000 // 5 AKT default

    // Ensure orchestrator is started
    if (!this.isReady()) {
      await this.start()
    }

    // Fetch the service from the registry with its related resources
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: {
        site: true,
        afFunction: true,
      },
    })

    if (!service) {
      throw new Error(`Service not found: ${serviceId}`)
    }

    // Close any existing ACTIVE deployments for this service before creating a new one
    const existingDeployments = await this.prisma.akashDeployment.findMany({
      where: {
        serviceId: service.id,
        status: 'ACTIVE',
      },
    })

    if (existingDeployments.length > 0) {
      console.log(`[AkashOrchestrator] Closing ${existingDeployments.length} existing deployment(s) for service ${service.name}...`)
      
      for (const existing of existingDeployments) {
        try {
          const existingDseq = Number(existing.dseq)
          console.log(`[AkashOrchestrator] Closing previous deployment dseq=${existingDseq}...`)
          await this.closeDeployment(existingDseq)
          
          await this.prisma.akashDeployment.update({
            where: { id: existing.id },
            data: { status: 'CLOSED', closedAt: new Date() },
          })
          console.log(`[AkashOrchestrator] Closed deployment dseq=${existingDseq}`)
        } catch (err: any) {
          console.warn(`[AkashOrchestrator] Failed to close deployment dseq=${existing.dseq}: ${err.message}`)
          // Mark as closed anyway if it doesn't exist on chain
          await this.prisma.akashDeployment.update({
            where: { id: existing.id },
            data: { status: 'CLOSED', closedAt: new Date() },
          })
        }
      }
    }

    // Generate or use provided SDL
    const sdl = options.sdlContent || await this.generateSDLForService(service)

    // Get wallet address
    const owner = await this.getAccountAddress()

    let deployment: Awaited<ReturnType<typeof this.prisma.akashDeployment.create>> | null = null

    try {
      // Create deployment on chain FIRST to get the dseq
      console.log(`[AkashOrchestrator] Creating deployment for ${service.type}:${service.name}...`)
      const { dseq } = await this.createDeployment(sdl, deposit)
      console.log(`[AkashOrchestrator] Deployment created with dseq: ${dseq} (type: ${typeof dseq})`)

      // dseq is already validated as an integer in createDeployment
      deployment = await this.prisma.akashDeployment.create({
        data: {
          owner,
          dseq: BigInt(dseq),
          sdlContent: sdl,
          serviceId: service.id,
          // Also link to specific resource type for convenience queries
          afFunctionId: service.type === 'FUNCTION' ? service.afFunction?.id : null,
          siteId: service.type === 'SITE' ? service.site?.id : null,
          depositUakt: BigInt(deposit),
          status: 'WAITING_BIDS',
        },
      })

      // Wait for bids (poll with exponential backoff)
      console.log('[AkashOrchestrator] Waiting for bids...')
      let bids: Awaited<ReturnType<typeof this.getBids>> = []
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 5000 * (i + 1))) // 5s, 10s, 15s...
        bids = await this.getBids(owner, dseq)
        if (bids.length > 0) break
      }

      if (bids.length === 0) {
        throw new Error('No bids received within timeout')
      }

      console.log('[AkashOrchestrator] Received bids:', JSON.stringify(bids, null, 2))

      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: { status: 'SELECTING_BID' },
      })

      // Filter bids to exclude blocked providers, then select cheapest
      // Use 'standalone' type since functions don't route through proxy
      const filteredBids = providerSelector.filterBids(bids as any, 'standalone')
      const safeBids = filteredBids.filter(b => b.isSafe)
      
      if (safeBids.length === 0) {
        // Log which providers were blocked
        const blockedProviders = filteredBids.filter(b => !b.isSafe)
        console.log('[AkashOrchestrator] All bids were from blocked providers:', 
          blockedProviders.map(b => `${b.bidId.provider}: ${b.unsafeReason}`).join(', '))
        throw new Error('No safe bids available - all providers are blocked')
      }
      
      console.log(`[AkashOrchestrator] ${safeBids.length}/${bids.length} bids from safe providers`)

      // Select cheapest safe bid - price.amount may be a decimal string, so use parseFloat
      const selectedBid = safeBids.sort((a, b) => {
        const priceA = parseFloat(a.price.amount) || 0
        const priceB = parseFloat(b.price.amount) || 0
        return priceA - priceB
      })[0]

      const provider = selectedBid.bidId.provider
      const gseq = selectedBid.bidId.gseq
      const oseq = selectedBid.bidId.oseq

      // Create lease
      console.log('[AkashOrchestrator] Creating lease with provider:', provider)
      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: {
          provider,
          gseq,
          oseq,
          pricePerBlock: selectedBid.price.amount,
          status: 'CREATING_LEASE',
        },
      })

      await this.createLease(owner, dseq, gseq, oseq, provider)

      // Send manifest
      console.log('[AkashOrchestrator] Sending manifest...')
      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: { status: 'SENDING_MANIFEST' },
      })

      await this.sendManifest(sdl, owner, dseq, gseq, oseq, provider)

      // Wait for services to be ready
      console.log('[AkashOrchestrator] Waiting for services...')
      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: { status: 'DEPLOYING' },
      })

      let akashServices: Record<string, { uris: string[] }> = {}
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 5000)) // 5s intervals
        try {
          akashServices = await this.getServices(owner, dseq, gseq, oseq, provider)
          // Check if any service has URIs
          const hasUris = Object.values(akashServices).some(s => s.uris?.length > 0)
          if (hasUris) break
        } catch {
          // Services not ready yet
        }
      }

      // Update deployment as active
      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: {
          status: 'ACTIVE',
          serviceUrls: akashServices,
          deployedAt: new Date(),
        },
      })

      // Update the specific resource based on service type
      const firstAkashService = Object.values(akashServices)[0]
      const invokeUrl = firstAkashService?.uris?.[0] || null

      if (service.type === 'FUNCTION' && service.afFunction) {
        await this.prisma.aFFunction.update({
          where: { id: service.afFunction.id },
          data: {
            status: 'ACTIVE',
            invokeUrl,
          },
        })
      }
      // Future: handle SITE, VM, DATABASE, etc.

      console.log('[AkashOrchestrator] Deployment complete:', invokeUrl)
      return deployment.id
    } catch (error) {
      // Update deployment as failed (if it was created)
      if (deployment) {
        await this.prisma.akashDeployment.update({
          where: { id: deployment.id },
          data: {
            status: 'FAILED',
            errorMessage:
              error instanceof Error ? error.message : 'Unknown error',
          },
        })
      }

      // Update the specific resource status based on service type
      if (service.type === 'FUNCTION' && service.afFunction) {
        await this.prisma.aFFunction.update({
          where: { id: service.afFunction.id },
          data: { status: 'FAILED' },
        })
      }

      throw error
    }
  }

  /**
   * Deploy a function to Akash (convenience method)
   * This wraps deployService for backwards compatibility.
   */
  async deployFunction(
    functionId: string,
    sourceCode: string,
    functionName: string,
    deposit = 5000000 // 5 AKT default
  ): Promise<string> {
    // Get the function to find its serviceId
    const func = await this.prisma.aFFunction.findUnique({
      where: { id: functionId },
      select: { serviceId: true },
    })

    if (!func?.serviceId) {
      throw new Error('Function has no associated service in the registry')
    }

    return this.deployService(func.serviceId, { deposit })
  }

  /**
   * Generate SDL based on service type.
   *
   * FUNCTION uses special source-code injection logic (inline SDL generation).
   * SITE, VM, DATABASE now use the template system for SDL generation.
   * Any service type with a matching template definition will use the template converter.
   */
  private async generateSDLForService(
    service: {
      type: ServiceType
      name: string
      slug: string
      site?: { id: string } | null
      afFunction?: { id: string; sourceCode: string | null } | null
    }
  ): Promise<string> {
    // FUNCTION has special source-code-injection logic, keep inline
    if (service.type === 'FUNCTION') {
      if (!service.afFunction?.sourceCode) {
        throw new Error('Function has no source code')
      }
      return this.generateFunctionSDL(service.slug, service.afFunction.sourceCode)
    }

    // For other types, try the template system first (unified SDL generation)
    const { getTemplateById, generateSDLFromTemplate } = await import('../../templates/index.js')

    // Map service types to default template IDs
    const typeToTemplate: Record<string, string> = {
      SITE: 'nginx-site',     // no template yet — fall back to legacy
      VM: 'node-ws-gameserver', // will use template if deploying a template
      DATABASE: 'postgres',
    }

    // Try to find a matching template
    const templateId = typeToTemplate[service.type]
    if (templateId) {
      const template = getTemplateById(templateId)
      if (template) {
        return generateSDLFromTemplate(template, { serviceName: service.slug })
      }
    }

    // Fall back to legacy inline SDL generators
    switch (service.type) {
      case 'SITE':
        return this.generateSiteSDL(service.slug)

      case 'VM':
        return this.generateVMSDL(service.slug)

      case 'DATABASE':
        return this.generateDatabaseSDL(service.slug)

      default:
        throw new Error(`SDL generation not supported for service type: ${service.type}`)
    }
  }

  /**
   * Generate SDL for a Bun/Hono function
   * Uses base64 encoding to safely embed source code in YAML
   */
  private generateFunctionSDL(name: string, sourceCode: string): string {
    // Base64 encode the source code to avoid YAML special character issues
    const base64Code = Buffer.from(sourceCode, 'utf-8').toString('base64')
    
    // Extract imports to determine dependencies to install
    const imports = sourceCode.match(/from ['"]([^'"./][^'"]*)['"]/g) || []
    const packages = [...new Set(imports.map(i => {
      const match = i.match(/from ['"]([^'"./][^'"]*)['"]/)?.[1]
      // Get the package name (handle scoped packages and subpaths)
      return match?.split('/').slice(0, match.startsWith('@') ? 2 : 1).join('/') || ''
    }).filter(Boolean))]
    
    const installCmd = packages.length > 0 
      ? `bun add ${packages.join(' ')}` 
      : 'echo "No dependencies to install"'
    
    return `---
version: "2.0"

services:
  ${name}:
    image: oven/bun:1.1-alpine
    env:
      - PORT=3000
    command:
      - sh
      - -c
      - |
        echo 'Deploying function...'
        mkdir -p /app
        cd /app
        bun init -y
        echo '${base64Code}' | base64 -d > /app/index.ts
        echo 'Installing dependencies: ${packages.join(', ') || 'none'}'
        ${installCmd}
        echo 'Starting function...'
        bun run index.ts
    expose:
      - port: 3000
        as: 80
        to:
          - global: true

profiles:
  compute:
    ${name}:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 512Mi
        storage:
          size: 1Gi

  placement:
    dcloud:
      pricing:
        ${name}:
          denom: uakt
          amount: 1000

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }

  /**
   * Generate SDL for a static site (nginx-based)
   */
  private generateSiteSDL(name: string): string {
    // For sites, we use nginx to serve static content
    // The content would typically be injected via build artifacts
    return `---
version: "2.0"

services:
  ${name}:
    image: nginx:alpine
    env:
      - NGINX_PORT=80
    expose:
      - port: 80
        as: 80
        to:
          - global: true

profiles:
  compute:
    ${name}:
      resources:
        cpu:
          units: 0.25
        memory:
          size: 256Mi
        storage:
          size: 1Gi

  placement:
    dcloud:
      pricing:
        ${name}:
          denom: uakt
          amount: 500

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }

  /**
   * Generate SDL for a VM-style deployment (Ubuntu base)
   */
  private generateVMSDL(name: string): string {
    return `---
version: "2.0"

services:
  ${name}:
    image: ubuntu:22.04
    command:
      - sh
      - -c
      - |
        apt-get update && apt-get install -y openssh-server
        mkdir /run/sshd
        echo 'root:akash' | chpasswd
        sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
        /usr/sbin/sshd -D
    expose:
      - port: 22
        as: 22
        to:
          - global: true
      - port: 80
        as: 80
        to:
          - global: true

profiles:
  compute:
    ${name}:
      resources:
        cpu:
          units: 1
        memory:
          size: 1Gi
        storage:
          size: 10Gi

  placement:
    dcloud:
      pricing:
        ${name}:
          denom: uakt
          amount: 2000

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }

  /**
   * Generate SDL for a database deployment (PostgreSQL)
   */
  private generateDatabaseSDL(name: string): string {
    return `---
version: "2.0"

services:
  ${name}:
    image: postgres:15-alpine
    env:
      - POSTGRES_DB=akashdb
      - POSTGRES_USER=akash
      - POSTGRES_PASSWORD=akash_secure_password
    expose:
      - port: 5432
        as: 5432
        to:
          - global: true

profiles:
  compute:
    ${name}:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 1Gi
        storage:
          size: 10Gi

  placement:
    dcloud:
      pricing:
        ${name}:
          denom: uakt
          amount: 1500

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }
}

// Singleton instance
let orchestratorInstance: AkashOrchestrator | null = null

export function getAkashOrchestrator(
  prisma: PrismaClient
): AkashOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new AkashOrchestrator(prisma)
  }
  return orchestratorInstance
}
