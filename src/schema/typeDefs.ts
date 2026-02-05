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
    # SDK compatibility field
    maskedToken: String
    expiresAt: Date
    lastUsedAt: Date
    createdAt: Date!
    updatedAt: Date!
  }

  """
  Wrapper type for tokens list (SDK compatibility)
  """
  type PersonalAccessTokenList {
    data: [PersonalAccessToken!]!
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
    avatar: String
    backupStorageOnArweave: Boolean
    backupStorageOnFilecoin: Boolean
    user: User!
    sites: [Site!]!
    functions: [AFFunction!]!
    createdAt: Date!
    updatedAt: Date!
  }

  """
  Wrapper type for paginated project list (SDK compatibility)
  """
  type ProjectList {
    data: [Project!]!
  }

  # ============================================
  # SERVICE REGISTRY (canonical workloads)
  # ============================================

  enum ServiceType {
    SITE
    FUNCTION
    VM
    DATABASE
    CRON
    BUCKET
  }

  type Service {
    id: ID!
    type: ServiceType!
    name: String!
    slug: String!
    projectId: ID!
    createdByUserId: ID
    createdAt: Date!
    updatedAt: Date!

    # Convenience links to the concrete resource
    site: Site
    afFunction: AFFunction
    
    # Akash deployments for this service
    akashDeployments: [AkashDeployment!]!
    # Get the currently active Akash deployment (if any)
    activeAkashDeployment: AkashDeployment
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
    # SDK compatibility fields
    zones: [Zone!]!
    ipnsRecords: [IPNSRecord!]!
    primaryDomain: Domain
    # Akash deployments for this site
    akashDeployments: [AkashDeployment!]!
    createdAt: Date!
    updatedAt: Date!
  }

  """
  Wrapper type for paginated site list (SDK compatibility)
  """
  type SiteList {
    data: [Site!]!
  }

  type Deployment {
    id: ID!
    cid: String!
    status: DeploymentStatus!
    storageType: StorageType!
    # SDK compatibility field
    siteId: ID!
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
    sourceCode: String
    invokeUrl: String
    # SDK compatibility fields (backed by Prisma columns)
    projectId: ID!
    currentDeploymentId: ID
    routes: JSON
    status: FunctionStatus!
    project: Project!
    siteId: String
    currentDeployment: AFFunctionDeployment
    deployments: [AFFunctionDeployment!]!
    akashDeployments: [AkashDeployment!]!
    createdAt: Date!
    updatedAt: Date!
  }

  """
  Wrapper type for function list (SDK compatibility)
  """
  type AFFunctionList {
    data: [AFFunction!]!
  }

  type AFFunctionDeployment {
    id: ID!
    # SDK compatibility field (backed by Prisma column)
    afFunctionId: ID!
    cid: String!
    blake3Hash: String
    assetsCid: String
    sgx: Boolean!
    afFunction: AFFunction!
    createdAt: Date!
    updatedAt: Date!
  }

  """
  Wrapper type for function deployments list (SDK compatibility)
  """
  type AFFunctionDeploymentList {
    data: [AFFunctionDeployment!]!
  }

  # Function inputs (SDK compatibility)
  input AFFunctionByNameWhereInput {
    name: String!
  }

  input AFFunctionWhereInput {
    id: ID!
  }

  """
  SDK compatibility input type for creating a function.
  Some clients (including the CLI/SDK) use CreateAFFunctionDataInput.
  """
  input CreateAFFunctionDataInput {
    name: String
    siteId: ID
    slug: String
    sourceCode: String
    routes: JSON
    status: FunctionStatus
  }

  """
  SDK compatibility input type for updating a function.
  Some clients (including the CLI/SDK) use UpdateAFFunctionDataInput.
  """
  input UpdateAFFunctionDataInput {
    name: String
    siteId: ID
    slug: String
    sourceCode: String
    routes: JSON
    status: FunctionStatus
  }

  input AFFunctionDeploymentsWhereInput {
    afFunctionId: ID!
    # Backwards/SDK compatibility alias (some clients send functionId)
    functionId: ID
  }

  input AFFunctionDeploymentWhereInput {
    id: ID
    cid: String
    functionId: ID
  }

  input TriggerAFFunctionDeploymentWhereInput {
    functionId: ID!
    cid: String
  }

  input TriggerAFFunctionDeploymentDataInput {
    cid: String
    assetsCid: String
    blake3Hash: String
    sgx: Boolean
  }

  input DeleteAFFunctionWhereInput {
    id: ID!
  }

  enum FunctionStatus {
    ACTIVE
    INACTIVE
    DEPLOYING
    FAILED
  }

  # ============================================
  # AKASH DEPLOYMENTS
  # ============================================

  """
  AkashDeployment represents a deployment of any service type to the Akash Network.
  It is linked to the canonical Service registry and can optionally link to 
  specific resource types (Site, Function) for convenience queries.
  """
  type AkashDeployment {
    id: ID!
    owner: String!
    dseq: String!
    gseq: Int!
    oseq: Int!
    provider: String
    status: AkashDeploymentStatus!
    serviceUrls: JSON
    sdlContent: String!
    
    # Link to canonical Service registry
    serviceId: ID!
    service: Service!
    
    # Optional convenience links to specific resource types
    afFunctionId: ID
    afFunction: AFFunction
    siteId: ID
    site: Site
    
    depositUakt: String
    pricePerBlock: String
    errorMessage: String
    createdAt: Date!
    updatedAt: Date!
    deployedAt: Date
    closedAt: Date
  }

  enum AkashDeploymentStatus {
    CREATING
    WAITING_BIDS
    SELECTING_BID
    CREATING_LEASE
    SENDING_MANIFEST
    DEPLOYING
    ACTIVE
    FAILED
    CLOSED
  }

  """
  Input for deploying a service to Akash. Supports any service type.
  """
  input DeployToAkashInput {
    # The canonical service ID from the Service registry
    serviceId: ID!
    # Deposit amount in uakt (default: 5000000 = 5 AKT)
    depositUakt: Int
    # Optional custom SDL content (if not provided, will be auto-generated based on service type)
    sdlContent: String
    # Optional source code for functions (will be saved before deployment)
    sourceCode: String
  }

  """
  Legacy input for deploying specifically a function to Akash.
  Prefer DeployToAkashInput for new integrations.
  """
  input DeployFunctionToAkashInput {
    functionId: ID!
    depositUakt: Int
  }

  # ============================================
  # DOMAINS
  # ============================================

  type Domain {
    id: ID!
    hostname: String!
    verified: Boolean!
    # SDK compatibility fields
    isVerified: Boolean!
    zone: Zone
    dnsConfigs: [DNSConfig!]!
    status: String
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

  type DNSConfig {
    id: ID!
    type: String!
    name: String!
    value: String!
    createdAt: Date!
    updatedAt: Date!
  }

  """
  Wrapper type for domains list (SDK compatibility)
  """
  type DomainList {
    data: [Domain!]!
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

  # ============================================
  # DNS RECORD MANAGEMENT (Admin)
  # ============================================

  type DNSRecord {
    id: String
    name: String!
    type: DNSRecordType!
    value: String!
    ttl: Int!
    priority: Int
  }

  enum DNSRecordType {
    A
    AAAA
    CNAME
    TXT
    MX
    NS
  }

  type DNSUpdateResult {
    success: Boolean!
    recordId: String
    error: String
  }

  input CreateDNSRecordInput {
    domain: String!
    name: String!
    type: DNSRecordType!
    value: String!
    ttl: Int
    priority: Int
  }

  input UpdateDNSRecordInput {
    domain: String!
    recordId: String!
    value: String
    ttl: Int
    priority: Int
  }

  input DeleteDNSRecordInput {
    domain: String!
    recordId: String!
  }

  input CreateDomainInput {
    hostname: String!
    siteId: ID!
    domainType: DomainType
    verificationMethod: String
  }

  """
  Input for exchanging a Personal Access Token for an access token
  """
  input LoginWithPersonalAccessTokenDataInput {
    personalAccessToken: String!
    projectId: ID
  }

  # ============================================
  # IPFS/STORAGE
  # ============================================

  type Pin {
    id: ID!
    cid: String!
    # SDK compatibility fields
    filename: String
    extension: String
    arweavePin: ArweavePin
    name: String
    size: Int
    deployment: Deployment!
    createdAt: Date!
    updatedAt: Date!
  }

  type ArweavePin {
    bundlrId: String
  }

  type PinList {
    data: [Pin!]!
  }

  input PinWhereInput {
    cid: String!
  }

  input PinsByFilenameWhereInput {
    filename: String!
    extension: String
  }

  type FilecoinDeal {
    dealId: String!
  }

  type FilecoinDealList {
    data: [FilecoinDeal!]!
  }

  input FilecoinDealsWhereInput {
    cid: String!
  }

  type IPNSRecord {
    id: ID!
    name: String!
    hash: String!
    # SDK compatibility field
    ensRecords: [EnsRecord!]!
    site: Site!
    createdAt: Date!
    updatedAt: Date!
  }

  # ENS (SDK compatibility)
  type EnsRecord {
    id: ID!
    name: String
    updatedAt: Date
    createdAt: Date
    status: String
    site: Site
    ipnsRecord: IPNSRecord
  }

  """
  Wrapper type for paginated IPNS record list (SDK compatibility)
  """
  type IpnsRecordList {
    data: [IPNSRecord!]!
  }

  """
  Zone type for DNS zone management
  """
  type Zone {
    id: ID!
    name: String!
    site: Site!
    # SDK compatibility fields (not backed by DB in this API)
    originUrl: String
    type: String
    status: String
    createdAt: Date!
    updatedAt: Date!
  }

  """
  Wrapper type for zones list (SDK compatibility)
  """
  type ZoneList {
    data: [Zone!]!
  }

  type ApplicationWhitelistDomain {
    id: ID!
    hostname: String!
    createdAt: Date
    updatedAt: Date
  }

  # Applications (SDK compatibility)
  type Application {
    id: ID!
    name: String!
    clientId: String!
    whitelistDomains: [ApplicationWhitelistDomain!]!
    whiteLabelDomains: [ApplicationWhitelistDomain!]!
    createdAt: Date
    updatedAt: Date
  }

  type ApplicationList {
    data: [Application!]!
  }

  # ENS list (SDK compatibility - minimal)
  type EnsRecordList {
    data: [EnsRecord!]!
  }

  input IPNSRecordWhereInput {
    ipnsRecordId: ID
  }

  # Sites list inputs (SDK compatibility)
  input SitesWhereInput {
    projectId: ID
  }

  # Site inputs (SDK compatibility)
  input SiteWhereInput {
    id: ID!
  }

  input SiteBySlugWhereInput {
    slug: String!
  }

  input SiteDataInput {
    name: String!
  }

  # Deployment inputs (SDK compatibility)
  input DeploymentWhereInput {
    id: ID!
  }

  input DeploymentDataInput {
    siteId: ID!
    cid: String!
  }

  """
  Private Gateway type for custom IPFS gateway access
  """
  type PrivateGateway {
    id: ID!
    name: String!
    slug: String!
    primaryDomain: Domain
    project: Project!
    zone: Zone
    createdAt: Date!
    updatedAt: Date!
  }

  """
  Wrapper type for paginated private gateway list (SDK compatibility)
  """
  type PrivateGatewayList {
    data: [PrivateGateway!]!
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

  # ============================================
  # OBSERVABILITY / APM
  # ============================================

  type Span {
    timestamp: Date!
    traceId: String!
    spanId: String!
    parentSpanId: String
    traceState: String
    spanName: String!
    spanKind: String!
    serviceName: String!
    resourceAttributes: JSON
    scopeName: String
    scopeVersion: String
    spanAttributes: JSON
    durationNs: String!
    durationMs: Float!
    statusCode: String!
    statusMessage: String
    events: [SpanEvent!]!
    links: [SpanLink!]!
  }

  type SpanEvent {
    timestamp: Date!
    name: String!
    attributes: JSON
  }

  type SpanLink {
    traceId: String!
    spanId: String!
    traceState: String
    attributes: JSON
  }

  type Trace {
    traceId: String!
    rootSpan: Span
    spans: [Span!]!
    serviceName: String!
    startTime: Date!
    endTime: Date!
    durationMs: Float!
    spanCount: Int!
    hasError: Boolean!
  }

  type MetricDataPoint {
    timestamp: Date!
    metricName: String!
    metricDescription: String
    metricUnit: String
    metricType: String!
    value: Float
    histogramCount: Int
    histogramSum: Float
    histogramBuckets: [Float!]
    histogramBucketCounts: [Int!]
    attributes: JSON
    resourceAttributes: JSON
  }

  type MetricSeries {
    metricName: String!
    metricUnit: String
    metricType: String!
    dataPoints: [MetricDataPoint!]!
  }

  type LogEntry {
    timestamp: Date!
    traceId: String
    spanId: String
    severityText: String!
    severityNumber: Int!
    body: String!
    resourceAttributes: JSON
    logAttributes: JSON
  }

  type ServiceStats {
    serviceName: String!
    spanCount: Int!
    traceCount: Int!
    errorCount: Int!
    errorRate: Float!
    avgDurationMs: Float!
    p50DurationMs: Float!
    p95DurationMs: Float!
    p99DurationMs: Float!
  }

  type ObservabilitySettings {
    id: ID!
    projectId: String!
    tracesEnabled: Boolean!
    metricsEnabled: Boolean!
    logsEnabled: Boolean!
    traceRetention: Int!
    metricRetention: Int!
    logRetention: Int!
    sampleRate: Float!
    maxBytesPerHour: String
    createdAt: Date!
    updatedAt: Date!
  }

  type TelemetryUsageSummary {
    projectId: String!
    bytesIngested: String!
    bytesFormatted: String!
    spansCount: Int!
    metricsCount: Int!
    logsCount: Int!
    costCents: Int!
    costFormatted: String!
    periodStart: Date!
    periodEnd: Date!
  }

  input TraceQueryInput {
    projectId: ID!
    startTime: Date!
    endTime: Date!
    serviceName: String
    spanName: String
    minDurationMs: Float
    maxDurationMs: Float
    statusCode: String
    traceId: String
    limit: Int
    offset: Int
  }

  input MetricQueryInput {
    projectId: ID!
    startTime: Date!
    endTime: Date!
    metricName: String
    aggregation: MetricAggregation
    interval: String
    limit: Int
  }

  enum MetricAggregation {
    AVG
    SUM
    MIN
    MAX
    COUNT
  }

  input LogQueryInput {
    projectId: ID!
    startTime: Date!
    endTime: Date!
    severityText: String
    minSeverityNumber: Int
    search: String
    traceId: String
    limit: Int
    offset: Int
  }

  input UpdateObservabilitySettingsInput {
    tracesEnabled: Boolean
    metricsEnabled: Boolean
    logsEnabled: Boolean
    traceRetention: Int
    metricRetention: Int
    logRetention: Int
    sampleRate: Float
    maxBytesPerHour: String
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
    personalAccessTokens: PersonalAccessTokenList!
    apiKeyRateLimit: ApiKeyRateLimit!

    # Projects
    project(id: ID!): Project
    projects: ProjectList!

    # Service Registry
    serviceRegistry(projectId: ID): [Service!]!

    # Sites
    site(where: SiteWhereInput!): Site
    sites(where: SitesWhereInput): SiteList!
    siteBySlug(where: SiteBySlugWhereInput!): Site

    # IPNS Records
    ipnsRecord(name: String!): IPNSRecord
    ipnsRecords: IpnsRecordList!

    # Private Gateways
    privateGateway(id: ID!): PrivateGateway
    privateGatewayBySlug(slug: String!): PrivateGateway
    privateGateways: PrivateGatewayList!

    # Deployments
    deployment(where: DeploymentWhereInput!): Deployment
    deployments(siteId: ID): [Deployment!]!

    # Functions
    afFunction(where: AFFunctionWhereInput!): AFFunction
    afFunctionByName(where: AFFunctionByNameWhereInput!): AFFunction
    afFunctions: AFFunctionList!
    afFunctionDeployment(where: AFFunctionDeploymentWhereInput!): AFFunctionDeployment
    afFunctionDeployments(where: AFFunctionDeploymentsWhereInput!): AFFunctionDeploymentList!

    # Domains
    domain(id: ID!): Domain
    domains: DomainList!
    domainByHostname(hostname: String!): Domain
    domainVerificationInstructions(
      domainId: ID!
    ): DomainVerificationInstructions!
    sslCertificateStatus: [SslCertificateStatusInfo!]!

    # Zones (SDK compatibility)
    zones: ZoneList!
    zone(id: ID!): Zone

    # Storage (SDK compatibility)
    pins: PinList!
    pin(where: PinWhereInput!): Pin
    pinsByFilename(where: PinsByFilenameWhereInput!): PinList!
    filecoinDeals(where: FilecoinDealsWhereInput!): FilecoinDealList!

    # ENS (SDK compatibility - minimal)
    ensRecords: EnsRecordList!
    ensRecordsByIpnsId(where: IPNSRecordWhereInput!): EnsRecordList!

    # Applications (SDK compatibility - minimal)
    applications: ApplicationList!

    # DNS Record Management (Admin)
    dnsRecords(domain: String!): [DNSRecord!]!
    dnsRecord(domain: String!, name: String!, type: DNSRecordType!): DNSRecord

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

    # Akash Deployments
    akashDeployment(id: ID!): AkashDeployment
    # List Akash deployments, optionally filtered by serviceId, functionId, or siteId
    akashDeployments(serviceId: ID, functionId: ID, siteId: ID): [AkashDeployment!]!
    # Get the active Akash deployment for a service
    akashDeploymentByService(serviceId: ID!): AkashDeployment
    # Legacy: Get the active Akash deployment for a function
    akashDeploymentByFunction(functionId: ID!): AkashDeployment

    # Storage Tracking
    pinnedContent(limit: Int): [PinnedContent!]!
    storageSnapshots(
      startDate: Date
      endDate: Date
      limit: Int
    ): [StorageSnapshot!]!
    storageStats: StorageTrackingStats!

    # Usage Buffer Monitoring
    usageBufferStats: UsageBufferStats!

    # Observability / APM
    traces(input: TraceQueryInput!): [Trace!]!
    trace(projectId: ID!, traceId: String!): Trace
    metrics(input: MetricQueryInput!): [MetricSeries!]!
    logs(input: LogQueryInput!): [LogEntry!]!
    services(projectId: ID!, startTime: Date!, endTime: Date!): [ServiceStats!]!
    observabilitySettings(projectId: ID!): ObservabilitySettings
    telemetryUsage(
      projectId: ID!
      startDate: Date!
      endDate: Date!
    ): TelemetryUsageSummary!
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

  # SDK compatibility input types
  input CreateProjectDataInput {
    name: String!
  }

  type Mutation {
    # Auth - SDK token exchange
    """
    Exchange a Personal Access Token for a short-lived access token.
    Used by the SDK to authenticate subsequent requests.
    """
    loginWithPersonalAccessToken(data: LoginWithPersonalAccessTokenDataInput!): String!

    # Auth
    createPersonalAccessToken(
      name: String!
      expiresAt: Date
    ): PersonalAccessTokenCreated!
    deletePersonalAccessToken(id: ID!): Boolean!

    # Projects
    createProject(data: CreateProjectDataInput!): Project!
    deleteProject(id: ID!): Boolean!

    # Sites
    createSite(data: SiteDataInput!): Site!
    deleteSite(where: SiteWhereInput!): Site!

    # Deployments
    createCustomIpfsDeployment(data: DeploymentDataInput!): Deployment!
    createDeployment(
      siteId: ID!
      sourceDirectory: String!
      storageType: StorageType
      buildOptions: BuildOptionsInput
    ): Deployment!

    # Functions
    createAFFunction(data: CreateAFFunctionDataInput!): AFFunction!
    updateAFFunction(where: AFFunctionWhereInput!, data: UpdateAFFunctionDataInput!): AFFunction!
    triggerAFFunctionDeployment(
      where: TriggerAFFunctionDeploymentWhereInput!
      data: TriggerAFFunctionDeploymentDataInput
    ): AFFunctionDeployment!
    deleteAFFunction(where: DeleteAFFunctionWhereInput!): AFFunction!

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

    # Observability Settings
    updateObservabilitySettings(
      projectId: ID!
      input: UpdateObservabilitySettingsInput!
    ): ObservabilitySettings!

    # DNS Record Management (Admin)
    addDnsRecord(input: CreateDNSRecordInput!): DNSUpdateResult!
    updateDnsRecord(input: UpdateDNSRecordInput!): DNSUpdateResult!
    deleteDnsRecord(input: DeleteDNSRecordInput!): DNSUpdateResult!

    # Web3 Domains
    registerArns(domainId: ID!, arnsName: String!, contentId: String!): Domain!
    updateArnsContent(domainId: ID!, contentId: String!): Domain!
    setEnsContentHash(
      domainId: ID!
      ensName: String!
      contentHash: String!
    ): Domain!
    publishIpns(domainId: ID!, cid: String!): Domain!
    updateIpns(domainId: ID!, cid: String!): Domain!

    # Akash Deployments
    # General-purpose: deploy any service to Akash
    deployToAkash(input: DeployToAkashInput!): AkashDeployment!
    # Legacy/convenience: deploy a function to Akash
    deployFunctionToAkash(input: DeployFunctionToAkashInput!): AkashDeployment!
    # Close an Akash deployment
    closeAkashDeployment(id: ID!): AkashDeployment!
  }

  # ============================================
  # SUBSCRIPTIONS
  # ============================================

  type Subscription {
    deploymentLogs(deploymentId: ID!): DeploymentLog!
    deploymentStatus(deploymentId: ID!): DeploymentStatusUpdate!
  }
`
