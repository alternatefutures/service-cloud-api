export const typeDefs = /* GraphQL */ `
  # ============================================
  # SCALARS
  # ============================================

  scalar Date
  scalar JSON

  # ============================================
  # USER & AUTHENTICATION
  # ============================================

  type User {
    id: ID!
    email: String
    username: String
    walletAddress: String
    projects: [Project!]!
    createdAt: Date!
    updatedAt: Date!
  }

  """
  PersonalAccessToken type for listing tokens (token value excluded for security)
  """
  type PersonalAccessToken {
    id: ID!
    name: String!
    expiresAt: Date
    lastUsedAt: Date
    createdAt: Date!
    updatedAt: Date!
  }

  """
  PersonalAccessTokenCreated type returned when creating a new token
  Includes the token value which is only shown once during creation
  """
  type PersonalAccessTokenCreated {
    id: ID!
    name: String!
    token: String!
    expiresAt: Date
    lastUsedAt: Date
    createdAt: Date!
    updatedAt: Date!
  }

  type ApiKeyRateLimit {
    remaining: Int!
    limit: Int!
    resetAt: Date!
    activeTokens: Int!
    maxActiveTokens: Int!
  }

  # ============================================
  # PROJECTS
  # ============================================

  type Project {
    id: ID!
    name: String!
    slug: String!
    user: User!
    sites: [Site!]!
    functions: [AFFunction!]!
    createdAt: Date!
    updatedAt: Date!
  }

  # ============================================
  # SITES & DEPLOYMENTS
  # ============================================

  type Site {
    id: ID!
    name: String!
    slug: String!
    project: Project!
    deployments: [Deployment!]!
    domains: [Domain!]!
    primaryDomain: Domain
    createdAt: Date!
    updatedAt: Date!
  }

  type Deployment {
    id: ID!
    cid: String!
    status: DeploymentStatus!
    storageType: StorageType!
    site: Site!
    pin: Pin
    createdAt: Date!
    updatedAt: Date!
  }

  enum DeploymentStatus {
    PENDING
    BUILDING
    UPLOADING
    SUCCESS
    FAILED
  }

  enum StorageType {
    IPFS
    ARWEAVE
    FILECOIN
  }

  # ============================================
  # FUNCTIONS
  # ============================================

  type AFFunction {
    id: ID!
    name: String!
    slug: String!
    invokeUrl: String
    routes: JSON
    status: FunctionStatus!
    project: Project!
    siteId: String
    currentDeployment: AFFunctionDeployment
    deployments: [AFFunctionDeployment!]!
    createdAt: Date!
    updatedAt: Date!
  }

  type AFFunctionDeployment {
    id: ID!
    cid: String!
    blake3Hash: String
    assetsCid: String
    sgx: Boolean!
    afFunction: AFFunction!
    createdAt: Date!
    updatedAt: Date!
  }

  enum FunctionStatus {
    ACTIVE
    INACTIVE
    DEPLOYING
    FAILED
  }

  # ============================================
  # DOMAINS
  # ============================================

  type Domain {
    id: ID!
    hostname: String!
    verified: Boolean!
    domainType: DomainType!
    site: Site!
    txtVerificationToken: String
    txtVerificationStatus: VerificationStatus!
    dnsVerifiedAt: Date
    sslStatus: SslStatus!
    sslIssuedAt: Date
    sslExpiresAt: Date
    sslAutoRenew: Boolean!
    arnsName: String
    ensName: String
    ipnsHash: String
    lastDnsCheck: Date
    dnsCheckAttempts: Int!
    createdAt: Date!
    updatedAt: Date!
  }

  enum DomainType {
    WEB2
    ARNS
    ENS
    IPNS
  }

  enum VerificationStatus {
    PENDING
    VERIFIED
    FAILED
  }

  enum SslStatus {
    NONE
    PENDING
    ACTIVE
    EXPIRED
    FAILED
  }

  type DomainVerificationInstructions {
    method: String!
    recordType: String!
    hostname: String!
    value: String!
    instructions: String!
  }

  type SslCertificateStatusInfo {
    id: ID!
    hostname: String!
    sslStatus: SslStatus!
    sslExpiresAt: Date
    sslAutoRenew: Boolean!
    verified: Boolean!
    daysUntilExpiry: Int
    needsRenewal: Boolean!
    isExpired: Boolean!
    site: Site!
  }

  input CreateDomainInput {
    hostname: String!
    siteId: ID!
    domainType: DomainType
    verificationMethod: String
  }

  # ============================================
  # IPFS/STORAGE
  # ============================================

  type Pin {
    id: ID!
    cid: String!
    name: String
    size: Int
    deployment: Deployment!
    createdAt: Date!
    updatedAt: Date!
  }

  type IPNSRecord {
    id: ID!
    name: String!
    hash: String!
    site: Site!
    createdAt: Date!
    updatedAt: Date!
  }

  # ============================================
  # STORAGE ANALYTICS
  # ============================================

  type StorageAnalytics {
    totalSize: Float!
    ipfsSize: Float!
    arweaveSize: Float!
    deploymentCount: Int!
    siteCount: Int!
    breakdown: [StorageBreakdown!]!
  }

  type StorageBreakdown {
    id: ID!
    name: String!
    type: StorageBreakdownType!
    size: Float!
    deploymentCount: Int!
    storageType: StorageType!
    lastDeployment: Date
  }

  enum StorageBreakdownType {
    SITE
    FUNCTION
  }

  type StorageUsageTrend {
    date: Date!
    totalSize: Float!
    deploymentCount: Int!
  }

  # ============================================
  # VERSION & EVENTS
  # ============================================

  type Version {
    commitHash: String!
  }

  type DeploymentLog {
    deploymentId: ID!
    timestamp: Date!
    message: String!
    level: String!
  }

  type DeploymentStatusUpdate {
    deploymentId: ID!
    status: DeploymentStatus!
    timestamp: Date!
  }

  # ============================================
  # SUBSCRIPTION HEALTH MONITORING
  # ============================================

  type SubscriptionHealth {
    status: HealthStatus!
    metrics: SubscriptionMetrics!
    alerts: [String!]!
  }

  enum HealthStatus {
    healthy
    degraded
    unhealthy
  }

  type SubscriptionMetrics {
    activeSubscriptions: Int!
    totalSubscriptionsCreated: Int!
    totalSubscriptionsClosed: Int!
    totalEventsEmitted: Int!
    lastEventTimestamp: Date
    errors: [SubscriptionError!]!
  }

  type SubscriptionError {
    timestamp: Date!
    error: String!
    deploymentId: String
  }

  # ============================================
  # AGENT CHAT SYSTEM
  # ============================================

  type Agent {
    id: ID!
    name: String!
    slug: String!
    description: String
    avatar: String
    systemPrompt: String
    model: String!
    status: AgentStatus!
    userId: ID!
    user: User!
    afFunction: AFFunction
    chats: [Chat!]!
    createdAt: Date!
    updatedAt: Date!
  }

  enum AgentStatus {
    ACTIVE
    INACTIVE
    TRAINING
    ERROR
  }

  type Chat {
    id: ID!
    title: String
    userId: ID!
    user: User!
    agentId: ID!
    agent: Agent!
    messages: [Message!]!
    lastMessageAt: Date
    metadata: JSON
    createdAt: Date!
    updatedAt: Date!
  }

  type Message {
    id: ID!
    content: String!
    role: MessageRole!
    chatId: ID!
    chat: Chat!
    userId: ID
    user: User
    agentId: ID
    agent: Agent
    attachments: [Attachment!]!
    metadata: JSON
    createdAt: Date!
    updatedAt: Date!
  }

  enum MessageRole {
    USER
    AGENT
    SYSTEM
  }

  type Attachment {
    id: ID!
    filename: String!
    contentType: String!
    size: Int!
    url: String!
    cid: String
    storageType: StorageType
    createdAt: Date!
    updatedAt: Date!
  }

  input CreateAgentInput {
    name: String!
    slug: String!
    description: String
    systemPrompt: String
    model: String
    functionId: ID
  }

  input CreateChatInput {
    agentId: ID!
    title: String
  }

  input SendMessageInput {
    chatId: ID!
    content: String!
  }

  # ============================================
  # BILLING SYSTEM
  # ============================================

  type Customer {
    id: ID!
    userId: ID!
    user: User!
    email: String
    name: String
    stripeCustomerId: String
    defaultPaymentMethod: PaymentMethod
    paymentMethods: [PaymentMethod!]!
    subscriptions: [Subscription!]!
    invoices: [Invoice!]!
    createdAt: Date!
    updatedAt: Date!
  }

  # ============================================
  # STORAGE TRACKING FOR BILLING
  # ============================================

  type PinnedContent {
    id: ID!
    userId: ID!
    user: User!
    cid: String!
    sizeBytes: String!
    pinnedAt: Date!
    unpinnedAt: Date
    filename: String
    mimeType: String
    metadata: JSON
    createdAt: Date!
    updatedAt: Date!
  }

  type StorageSnapshot {
    id: ID!
    userId: ID!
    user: User!
    date: Date!
    totalBytes: String!
    pinCount: Int!
    createdAt: Date!
  }

  type StorageTrackingStats {
    currentBytes: String!
    currentBytesFormatted: String!
    pinCount: Int!
    lastSnapshot: StorageSnapshot
  }

  # ============================================
  # USAGE BUFFER MONITORING
  # ============================================

  type UsageBufferStats {
    activeUsers: Int!
    totalBandwidth: Float!
    totalCompute: Float!
    totalRequests: Int!
    bufferHealthy: Boolean!
  }

  type FlushUsageBufferResult {
    success: Boolean!
    usersFlushed: Int!
    errors: Int!
    duration: Int!
    message: String!
  }

  type PaymentMethod {
    id: ID!
    type: PaymentMethodType!
    customer: Customer!
    cardBrand: String
    cardLast4: String
    cardExpMonth: Int
    cardExpYear: Int
    walletAddress: String
    blockchain: String
    isDefault: Boolean!
    createdAt: Date!
  }

  enum PaymentMethodType {
    CARD
    CRYPTO_WALLET
  }

  type Subscription {
    id: ID!
    status: SubscriptionStatus!
    plan: SubscriptionPlan!
    customer: Customer!
    basePricePerSeat: Float!
    usageMarkup: Float!
    seats: Int!
    currentPeriodStart: Date!
    currentPeriodEnd: Date!
    cancelAt: Date
    createdAt: Date!
    updatedAt: Date!
  }

  enum SubscriptionStatus {
    ACTIVE
    PAST_DUE
    CANCELED
    TRIALING
    PAUSED
  }

  enum SubscriptionPlan {
    FREE
    STARTER
    PRO
    ENTERPRISE
  }

  type Invoice {
    id: ID!
    invoiceNumber: String!
    status: InvoiceStatus!
    customer: Customer!
    subscription: Subscription
    subtotal: Int!
    tax: Int!
    total: Int!
    amountPaid: Int!
    amountDue: Int!
    currency: String!
    periodStart: Date!
    periodEnd: Date!
    dueDate: Date
    paidAt: Date
    pdfUrl: String
    lineItems: [InvoiceLineItem!]!
    createdAt: Date!
  }

  enum InvoiceStatus {
    DRAFT
    OPEN
    PAID
    VOID
    UNCOLLECTIBLE
  }

  type InvoiceLineItem {
    id: ID!
    description: String!
    quantity: Float!
    unitPrice: Int!
    amount: Int!
  }

  type Payment {
    id: ID!
    customer: Customer!
    invoice: Invoice
    paymentMethod: PaymentMethod
    amount: Int!
    currency: String!
    status: PaymentStatus!
    txHash: String
    blockchain: String
    failureMessage: String
    createdAt: Date!
  }

  enum PaymentStatus {
    PENDING
    PROCESSING
    SUCCEEDED
    FAILED
    CANCELED
    REFUNDED
  }

  type UsageRecord {
    id: ID!
    customer: Customer!
    type: UsageType!
    resourceType: String!
    quantity: Float!
    unit: String!
    amount: Int
    timestamp: Date!
  }

  enum UsageType {
    STORAGE
    BANDWIDTH
    COMPUTE
    REQUESTS
    SEATS
  }

  type UsageSummary {
    storage: UsageMetric!
    bandwidth: UsageMetric!
    compute: UsageMetric!
    requests: UsageMetric!
    total: Int!
  }

  type UsageMetric {
    quantity: Float!
    amount: Int!
  }

  type BillingSettings {
    id: ID!
    pricePerSeatCents: Int!
    usageMarkupPercent: Float!
    storagePerGBCents: Int!
    bandwidthPerGBCents: Int!
    computePerHourCents: Int!
    requestsPer1000Cents: Int!
    taxRatePercent: Float!
    invoiceDueDays: Int!
    trialPeriodDays: Int!
  }

  input CreateSubscriptionInput {
    plan: SubscriptionPlan!
    seats: Int
  }

  input AddPaymentMethodInput {
    stripePaymentMethodId: String
    walletAddress: String
    blockchain: String
    setAsDefault: Boolean
  }

  input RecordCryptoPaymentInput {
    txHash: String!
    blockchain: String!
    amount: Int!
    invoiceId: ID
  }

  input UpdateBillingSettingsInput {
    pricePerSeatCents: Int
    usageMarkupPercent: Float
    storagePerGBCents: Int
    bandwidthPerGBCents: Int
    computePerHourCents: Int
    requestsPer1000Cents: Int
    taxRatePercent: Float
    invoiceDueDays: Int
    trialPeriodDays: Int
  }

  # ============================================
  # QUERIES
  # ============================================

  type Query {
    # Version
    version: Version!

    # User & Auth
    me: User
    personalAccessTokens: [PersonalAccessToken!]!
    apiKeyRateLimit: ApiKeyRateLimit!

    # Projects
    project(id: ID!): Project
    projects: [Project!]!

    # Sites
    site(id: ID!): Site
    sites: [Site!]!
    siteBySlug(slug: String!): Site

    # Deployments
    deployment(id: ID!): Deployment
    deployments(siteId: ID): [Deployment!]!

    # Functions
    afFunctionByName(name: String!): AFFunction
    afFunctions: [AFFunction!]!
    afFunctionDeployment(id: ID!): AFFunctionDeployment
    afFunctionDeployments(functionId: ID!): [AFFunctionDeployment!]!

    # Domains
    domain(id: ID!): Domain
    domains(siteId: ID): [Domain!]!
    domainByHostname(hostname: String!): Domain
    domainVerificationInstructions(domainId: ID!): DomainVerificationInstructions!
    sslCertificateStatus: [SslCertificateStatusInfo!]!

    # Storage Analytics
    storageAnalytics(projectId: ID): StorageAnalytics!
    storageUsageTrend(projectId: ID, days: Int): [StorageUsageTrend!]!

    # System Health
    subscriptionHealth: SubscriptionHealth!

    # Agent Chat
    agent(id: ID!): Agent
    agentBySlug(slug: String!): Agent
    agents: [Agent!]!
    chat(id: ID!): Chat
    chats: [Chat!]!
    messages(chatId: ID!, limit: Int, before: String): [Message!]!

    # Billing
    customer: Customer
    paymentMethods: [PaymentMethod!]!
    subscriptions: [Subscription!]!
    activeSubscription: Subscription
    invoices(status: InvoiceStatus, limit: Int): [Invoice!]!
    invoice(id: ID!): Invoice
    currentUsage: UsageSummary!
    billingSettings: BillingSettings

    # Storage Tracking
    pinnedContent(limit: Int): [PinnedContent!]!
    storageSnapshots(startDate: Date, endDate: Date, limit: Int): [StorageSnapshot!]!
    storageStats: StorageTrackingStats!

    # Usage Buffer Monitoring
    usageBufferStats: UsageBufferStats!
  }

  # ============================================
  # MUTATIONS
  # ============================================

  input BuildOptionsInput {
    buildCommand: String!
    installCommand: String
    workingDirectory: String
    outputDirectory: String
  }

  type Mutation {
    # Auth
    createPersonalAccessToken(name: String!, expiresAt: Date): PersonalAccessTokenCreated!
    deletePersonalAccessToken(id: ID!): Boolean!

    # Projects
    createProject(name: String!): Project!
    deleteProject(id: ID!): Boolean!

    # Sites
    createSite(name: String!, projectId: ID): Site!
    deleteSite(id: ID!): Boolean!

    # Deployments
    createDeployment(
      siteId: ID!
      sourceDirectory: String!
      storageType: StorageType
      buildOptions: BuildOptionsInput
    ): Deployment!

    # Functions
    createAFFunction(name: String!, siteId: ID, routes: JSON): AFFunction!
    deployAFFunction(
      functionId: ID!
      cid: String!
      sgx: Boolean
      blake3Hash: String
      assetsCid: String
    ): AFFunctionDeployment!
    updateAFFunction(
      id: ID!
      name: String
      slug: String
      routes: JSON
      status: FunctionStatus
    ): AFFunction!
    deleteAFFunction(id: ID!): Boolean!

    # Domains
    createDomain(input: CreateDomainInput!): Domain!
    verifyDomain(domainId: ID!): Boolean!
    provisionSsl(domainId: ID!, email: String!): Domain!
    renewSslCertificate(domainId: ID!): Domain!
    setPrimaryDomain(siteId: ID!, domainId: ID!): Boolean!
    deleteDomain(id: ID!): Boolean!

    # Agent Chat
    createAgent(input: CreateAgentInput!): Agent!
    createChat(input: CreateChatInput!): Chat!
    sendMessage(input: SendMessageInput!): Message!
    deleteChat(id: ID!): Boolean!

    # Billing
    createSubscription(input: CreateSubscriptionInput!): Subscription!
    cancelSubscription(id: ID!, immediately: Boolean): Subscription!
    updateSubscriptionSeats(id: ID!, seats: Int!): Subscription!
    addPaymentMethod(input: AddPaymentMethodInput!): PaymentMethod!
    removePaymentMethod(id: ID!): Boolean!
    setDefaultPaymentMethod(id: ID!): PaymentMethod!
    processPayment(amount: Int!, currency: String, invoiceId: ID): Payment!
    recordCryptoPayment(input: RecordCryptoPaymentInput!): Payment!
    generateInvoice(subscriptionId: ID!): Invoice!
    updateBillingSettings(input: UpdateBillingSettingsInput!): BillingSettings!

    # Storage Tracking
    triggerStorageSnapshot: StorageSnapshot!
    triggerInvoiceGeneration: [Invoice!]!

    # Usage Buffer Management
    flushUsageBuffer: FlushUsageBufferResult!

    # Web3 Domains
    registerArns(domainId: ID!, arnsName: String!, contentId: String!): Domain!
    updateArnsContent(domainId: ID!, contentId: String!): Domain!
    setEnsContentHash(domainId: ID!, ensName: String!, contentHash: String!): Domain!
    publishIpns(domainId: ID!, cid: String!): Domain!
    updateIpns(domainId: ID!, cid: String!): Domain!
  }

  # ============================================
  # SUBSCRIPTIONS
  # ============================================

  type Subscription {
    deploymentLogs(deploymentId: ID!): DeploymentLog!
    deploymentStatus(deploymentId: ID!): DeploymentStatusUpdate!
  }
`;
