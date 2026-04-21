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
    """
    Create-time discriminator describing the catalog flow that produced
    this service. One of 'docker' | 'server' | 'function' | 'template'.
    Null on legacy rows; the web app falls through to 'docker' for VM
    rows and 'function' for FUNCTION rows. Immutable after creation.
    (Phase 39)
    """
    flavor: String
    templateId: ID
    dockerImage: String
    containerPort: Int
    """
    Persistent volumes for raw Docker images. Templates use template.persistentStorage instead.
    Shape: Array<{ name: string; mountPath: string; size: string }>. (Phase 38)
    """
    volumes: JSON
    """
    Optional application HTTP health probe (Phase 42). Shape:
    JSON object with path (required, must start with /), optional port,
    expectStatus (default 200), intervalSec (default 30, clamped 10-3600),
    and timeoutSec (default 5, clamped 1-30). Null when no probe is configured.
    """
    healthProbe: JSON
    """
    Live application-level health derived from the configured healthProbe.
    Null until the runner has fired at least one probe. (Phase 42)
    """
    applicationHealth: ApplicationHealth
    """
    Optional health-aware auto-failover policy (Phase 43). Shape:
    JSON object with enabled (boolean), maxAttempts (default 3, clamped 1-10),
    and windowHours (default 24, clamped 1-720). When enabled, the sweeper
    redeploys to a different provider on provider-side failures rather than
    plain-closing the deployment. Refused for services with persistent
    volumes (data-loss risk) and for application-side failures.
    """
    failoverPolicy: JSON
    """
    Live failover history derived from this service's deployment chain.
    Null when no failover has ever fired for this service. (Phase 43)
    """
    failoverHistory: FailoverHistory
    internalHostname: String
    createdByUserId: ID
    parentServiceId: ID
    sdlServiceName: String
    shutdownPriority: Int!
    createdAt: Date!
    updatedAt: Date!

    # Convenience links to the concrete resource
    site: Site
    afFunction: AFFunction
    
    # Akash deployments for this service (or parent if companion)
    akashDeployments: [AkashDeployment!]!
    akashDeploymentCount: Int!
    activeAkashDeployment: AkashDeployment
    # Phala deployments for this service (or parent if companion)
    phalaDeployments: [PhalaDeployment!]!
    activePhalaDeployment: PhalaDeployment

    # Inter-service communication
    envVars: [ServiceEnvVar!]!
    ports: [ServicePort!]!
    linksFrom: [ServiceLink!]!
    linksTo: [ServiceLink!]!
  }

  # ============================================
  # SERVICE ENVIRONMENT VARIABLES
  # ============================================

  type ServiceEnvVar {
    id: ID!
    serviceId: ID!
    key: String!
    value: String!
    secret: Boolean!
    source: String
    createdAt: Date!
    updatedAt: Date!
  }

  # ============================================
  # SERVICE PORT CONFIGURATION
  # ============================================

  type ServicePort {
    id: ID!
    serviceId: ID!
    containerPort: Int!
    publicPort: Int
    protocol: String!
    createdAt: Date!
    updatedAt: Date!
  }

  # ============================================
  # APPLICATION HEALTH (Phase 42)
  # ============================================

  """
  Per-attempt result emitted by the application health runner.
  Newest result is appended to ApplicationHealth.recentResults; the
  buffer is capped at 20 entries per service.
  """
  type ProbeResult {
    timestamp: Date!
    ok: Boolean!
    statusCode: Int
    latencyMs: Int!
    error: String
  }

  """
  Aggregated application health derived from the in-memory probe ring buffer.
  The "overall" field summarises the last 3 results: "healthy" if all pass,
  "unhealthy" if all fail, "starting" if mixed, "unknown" if no probes
  have run yet.
  """
  type ApplicationHealth {
    overall: String!
    lastChecked: Date
    lastStatus: Int
    lastError: String
    recentResults: [ProbeResult!]!
  }

  # ============================================
  # FAILOVER HISTORY (Phase 43)
  # ============================================

  """
  One entry in the failover chain for a service. Newest first. Each attempt
  corresponds to one AkashDeployment row spawned by the sweeper after the
  previous attempt was declared dead.
  """
  type FailoverAttempt {
    deploymentId: ID!
    parentDeploymentId: ID
    provider: String
    excludedProviders: [String!]!
    status: String!
    reason: String
    createdAt: Date!
    deployedAt: Date
    closedAt: Date
  }

  """
  Aggregated failover history. attemptsInWindow counts failover-spawned
  deployments within the configured window (used for cap enforcement).
  """
  type FailoverHistory {
    attemptsInWindow: Int!
    maxAttempts: Int!
    windowHours: Int!
    chain: [FailoverAttempt!]!
  }

  # ============================================
  # SERVICE LINKS (inter-service connections)
  # ============================================

  type ServiceLink {
    id: ID!
    sourceServiceId: ID!
    targetServiceId: ID!
    sourceService: Service!
    targetService: Service!
    alias: String
    createdAt: Date!
    updatedAt: Date!
  }

  input EnvVarInput {
    key: String!
    value: String!
    secret: Boolean
  }

  input ServicePortInput {
    containerPort: Int!
    publicPort: Int
    protocol: String
  }

  # ============================================
  # SITES & DEPLOYMENTS
  # ============================================

  type Site {
    id: ID!
    name: String!
    slug: String!
    serviceId: ID
    service: Service
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
    serviceId: ID
    service: Service
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
  Generic input for creating a Service registry entry.
  Used for template-based services and raw compute services
  that don't need a specialized AFFunction or Site record.
  """
  input CreateServiceInput {
    name: String!
    projectId: ID!
    type: ServiceType
    templateId: String
    """
    Catalog flow discriminator. One of 'docker' | 'server' | 'function' | 'template'.
    Validated server-side; rejected if any other value. Immutable post-creation.
    (Phase 39)
    """
    flavor: String
    dockerImage: String
    containerPort: Int
  }

  """
  Patch a Service registry entry's source-of-truth fields. Used by the
  Source tab in the web app to let users set/update the Docker image
  reference and container port for VM/raw services after creation.

  Changes apply on the next deploy. The mutation rejects updates while
  a deployment is in flight (CREATING/WAITING_BIDS/SELECTING_BID/
  CREATING_LEASE/SENDING_MANIFEST/DEPLOYING) so the in-progress lease
  isn't operating against stale fields. ACTIVE deployments are fine to
  update against — the user must redeploy to pick the new values up.
  """
  input UpdateServiceInput {
    dockerImage: String
    containerPort: Int
    """
    Persistent volumes for raw Docker images. Pass an empty array to clear all
    volumes; pass null to leave unchanged. Each volume requires "name"
    (lowercase letters/digits/hyphen, max 31 chars), "mountPath" (absolute,
    no trailing slash), and "size" (e.g. "5Gi", "100Mi"). Max 4 per service.
    Templates ignore this field. (Phase 38)
    """
    volumes: JSON
    """
    Optional application HTTP health probe (Phase 42). Pass null to remove
    the probe; pass an object to set/replace it. Required key: path
    (must start with "/"). Optional keys: port (1-65535), expectStatus
    (HTTP code, default 200), intervalSec (default 30, clamped 10-3600),
    timeoutSec (default 5, clamped 1-30).
    """
    healthProbe: JSON
    """
    Optional health-aware auto-failover policy (Phase 43). Pass null to
    remove the policy; pass an object to set/replace it. Required key:
    enabled (boolean). Optional keys: maxAttempts (default 3, clamped 1-10),
    windowHours (default 24, clamped 1-720). Refused on services with
    persistent volumes — that combination would silently lose data on a
    failover event.
    """
    failoverPolicy: JSON
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
    image: String                 # container image from SDL (e.g. ghcr.io/alternatefutures/milady:v1)
    gpuModel: String              # GPU model resolved from provider after lease (e.g. "rtx4090", "a100")
    cpuUnits: Float               # deployed vCPU count from SDL
    memoryBytes: Float            # deployed memory bytes from SDL
    storageBytes: Float           # deployed total storage bytes from SDL (ephemeral + persistent)
    gpuUnits: Int                 # deployed GPU count from SDL
    retryCount: Int!
    parentDeploymentId: String
    costPerHour: Float
    costPerDay: Float
    costPerMonth: Float
    dailyRateCentsRaw: Int
    dailyRateCentsCharged: Int
    policy: DeploymentPolicy
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
    PERMANENTLY_FAILED
    SUSPENDED
    CLOSED
  }

  # ============================================
  # PHALA DEPLOYMENTS
  # ============================================

  type PhalaDeployment {
    id: ID!
    appId: String!
    name: String!
    status: PhalaDeploymentStatus!
    errorMessage: String
    composeContent: String!
    envKeys: [String!]
    appUrl: String
    teepod: String
    gpuModel: String
    cvmSize: String
    cpuUnits: Float               # live vCPU count from provider
    memoryBytes: Float            # live memory bytes from provider
    storageBytes: Float           # live disk bytes from provider
    gpuUnits: Int                 # live GPU count from provider

    serviceId: ID!
    service: Service!

    siteId: ID
    site: Site
    afFunctionId: ID
    afFunction: AFFunction

    retryCount: Int!
    parentDeploymentId: String
    costPerHour: Float
    costPerDay: Float
    costPerMonth: Float
    policy: DeploymentPolicy

    createdAt: Date!
    updatedAt: Date!
  }

  enum PhalaDeploymentStatus {
    CREATING
    STARTING
    ACTIVE
    FAILED
    STOPPED
    DELETED
    PERMANENTLY_FAILED
  }

  # ============================================
  # DEPLOYMENT HEALTH (live container status)
  # ============================================

  type ContainerHealth {
    name: String!
    status: String!
    ready: Boolean!
    total: Int!
    available: Int!
    uris: [String!]!
    message: String
  }

  type DeploymentHealth {
    provider: String!
    overall: String!
    containers: [ContainerHealth!]!
    lastChecked: Date!
  }

  type DeploymentProgress {
    deploymentId: String!
    provider: String!
    status: String!
    step: String!
    stepNumber: Int!
    totalSteps: Int!
    retryCount: Int!
    message: String
    errorMessage: String
    timestamp: String!
  }

  """
  Input for deploying a service to Akash. Supports any service type.
  """
  input DeployToAkashInput {
    # The canonical service ID from the Service registry
    serviceId: ID!
    # Deposit amount in uakt (default: 500000 = 0.5 AKT)
    depositUakt: Int
    # Optional custom SDL content (if not provided, will be auto-generated based on service type)
    sdlContent: String
    # Optional source code for functions (will be saved before deployment)
    sourceCode: String
    # Optional deployment policy (budget, GPU, runtime constraints)
    policy: DeploymentPolicyInput
    # Optional resource overrides (CPU, memory, storage, GPU) — overrides template defaults
    resourceOverrides: ResourceOverrideInput
    # Optional base Docker image for raw services without a template or custom image (e.g. "ubuntu:24.04")
    baseImage: String
  }

  """
  Input for deploying a service to Phala Cloud (TEE). Supports any service type
  that has a templateId (template-based) or custom compose content.
  """
  input DeployToPhalaInput {
    # The canonical service ID from the Service registry
    serviceId: ID!
    # Optional source code for functions (will be saved before deployment)
    sourceCode: String
    # Optional deployment policy (budget, GPU, runtime constraints)
    policy: DeploymentPolicyInput
    # Optional resource overrides (CPU, memory, storage, GPU) — overrides template defaults
    resourceOverrides: ResourceOverrideInput
    # Optional base Docker image for raw services without a template or custom image (e.g. "ubuntu:24.04")
    baseImage: String
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
    organizationId: ID
    site: Site
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

  # ============================================
  # DOMAIN REGISTRATION / PURCHASE
  # ============================================

  type DomainAvailability {
    domain: String!
    available: Boolean!
    status: String!
    reason: String
    isPremium: Boolean!
    price: DomainPrice
    premiumPrice: DomainPrice
  }

  type DomainPrice {
    currency: String!
    registrationPrice: Float!
  }

  type DomainPricing {
    currency: String!
    price: Float!
    isPremium: Boolean!
    isPromotion: Boolean!
    period: Int!
  }

  type DomainRegistrationResult {
    success: Boolean!
    domainId: Int
    status: String
    error: String
    domain: Domain
  }

  type RegisteredDomain {
    id: Int!
    fullName: String!
    name: String!
    extension: String!
    status: String!
    expirationDate: String!
    renewalDate: String!
    autorenew: String!
    whoisPrivacy: Boolean!
    createdAt: String
  }

  type RegisteredDomainList {
    domains: [RegisteredDomain!]!
    total: Int!
  }

  input CheckDomainAvailabilityInput {
    domains: [DomainNameInput!]!
    withPrice: Boolean
  }

  input DomainNameInput {
    name: String!
    extension: String!
  }

  input PurchaseDomainInput {
    name: String!
    extension: String!
    orgId: ID!
    period: Int
    enableWhoisPrivacy: Boolean
    autorenew: String
    acceptPremiumFee: Float
  }

  input CreateDomainInput {
    hostname: String!
    siteId: ID!
    domainType: DomainType
    verificationMethod: String
  }

  input CreateOrgDomainInput {
    hostname: String!
    orgId: ID!
    domainType: DomainType
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
  # WORKSPACE METRICS
  # ============================================

  type WorkspaceMetrics {
    compute: ComputeMetrics!
    deployments: DeploymentMetrics!
    spend: SpendMetrics!
  }

  type ComputeMetrics {
    activeDeploys: Int!
    totalCpuMillicores: Int!
    totalMemoryMb: Int!
    formatted: String!
  }

  type DeploymentMetrics {
    active: Int!
    total: Int!
    formatted: String!
  }

  type SpendMetrics {
    currentMonthCents: Int!
    formatted: String!
  }

  # ============================================
  # UNIFIED DEPLOYMENTS (cross-service view)
  # ============================================

  type UnifiedDeployment {
    id: ID!
    shortId: String!
    status: String!
    kind: String!                 # SITE, FUNCTION, AKASH, PHALA
    serviceName: String!
    serviceId: ID
    serviceSlug: String           # slug used for subdomain URL (slug.apps.alternatefutures.ai)
    serviceType: String!          # SITE, FUNCTION, VM, DATABASE, CRON, BUCKET
    projectId: String
    projectName: String
    source: String!               # cli, github, docker, etc.
    image: String                 # container image (Akash) or CID (IPFS)
    statusMessage: String
    createdAt: Date!
    updatedAt: Date
    author: UnifiedDeploymentAuthor
  }

  type UnifiedDeploymentAuthor {
    id: ID!
    name: String!
    avatarUrl: String
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

  type ServiceLogResult {
    logs: String!
    provider: String!
    deploymentId: String!
    timestamp: Date!
  }

  # ============================================
  # FEEDBACK & BUG REPORTS
  # ============================================

  enum FeedbackCategory {
    BUG
    FEEDBACK
    FEATURE_REQUEST
  }

  type FeedbackReport {
    id: ID!
    title: String!
    category: FeedbackCategory!
    location: String
    description: String!
    createdAt: Date!
  }

  input SubmitFeedbackInput {
    title: String!
    category: FeedbackCategory!
    location: String
    description: String!
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
  # STORAGE TRACKING
  # (Billing is handled entirely by service-auth)
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

  # ============================================
  # DEPLOYMENT POLICY (budget, GPU, runtime constraints)
  # ============================================

  enum PolicyStopReason {
    BUDGET_EXCEEDED
    RUNTIME_EXPIRED
    MANUAL_STOP
    BALANCE_LOW
  }

  type DeploymentPolicy {
    id: ID!
    acceptableGpuModels: [String!]!
    gpuUnits: Int
    gpuVendor: String
    maxBudgetUsd: Float
    maxMonthlyUsd: Float
    runtimeMinutes: Int
    expiresAt: Date
    reservedCents: Int!
    stopReason: PolicyStopReason
    stoppedAt: Date
    totalSpentUsd: Float!
    createdAt: Date!
    updatedAt: Date!
  }

  input DeploymentPolicyInput {
    acceptableGpuModels: [String!]
    gpuUnits: Int
    gpuVendor: String
    maxBudgetUsd: Float
    maxMonthlyUsd: Float
    runtimeMinutes: Int
  }

  # ============================================
  # TEMPLATES
  # ============================================

  enum TemplateCategory {
    GAME_SERVER
    WEB_SERVER
    DATABASE
    AI_ML
    DEVTOOLS
    CUSTOM
  }

  enum TemplateReleaseStage {
    production
    internal
  }

  type TemplateEnvVar {
    key: String!
    default: String
    description: String!
    required: Boolean!
    secret: Boolean
    platformInjected: String
  }

  type TemplateGpu {
    units: Int!
    vendor: String!
    model: String
  }

  type TemplateResources {
    cpu: Float!
    memory: String!
    storage: String!
    gpu: TemplateGpu
  }

  type TemplatePort {
    port: Int!
    as: Int!
    global: Boolean!
  }

  type TemplateHealthCheck {
    path: String!
    port: Int!
  }

  type TemplatePersistentStorage {
    name: String!
    size: String!
    mountPath: String!
  }

  type TemplateComponent {
    id: String!
    name: String!
    description: String
    primary: Boolean
    templateId: String
    internalOnly: Boolean
    sdlServiceName: String
    """Whether this component must be deployed (default true). Primary and internalOnly are always required."""
    required: Boolean
    """JSON-encoded fallback values when this component is disabled."""
    fallbacks: JSON
    """Resolved default resources for this component (from parent or referenced template)."""
    defaultResources: TemplateResources
  }

  type Template {
    id: ID!
    name: String!
    description: String!
    featured: Boolean
    releaseStage: TemplateReleaseStage!
    category: TemplateCategory!
    tags: [String!]!
    icon: String
    repoUrl: String!
    dockerImage: String!
    serviceType: String!
    envVars: [TemplateEnvVar!]!
    resources: TemplateResources!
    ports: [TemplatePort!]!
    healthCheck: TemplateHealthCheck
    persistentStorage: [TemplatePersistentStorage!]
    pricingUakt: Int
    components: [TemplateComponent!]
  }

  input EnvOverrideInput {
    key: String!
    value: String!
  }

  input GpuOverrideInput {
    units: Int!
    vendor: String!
    model: String
  }

  input ResourceOverrideInput {
    cpu: Float
    memory: String
    storage: String
    gpu: GpuOverrideInput
  }

  input DeployFromTemplateInput {
    templateId: String!
    projectId: ID!
    serviceName: String
    envOverrides: [EnvOverrideInput!]
    resourceOverrides: ResourceOverrideInput
    policy: DeploymentPolicyInput
  }

  input ComponentTargetInput {
    componentId: String!
    provider: String!
    resourceOverrides: ResourceOverrideInput
  }

  input DeployCompositeTemplateInput {
    templateId: String!
    projectId: ID!
    """Existing workspace service to reuse as the primary composite service."""
    primaryServiceId: ID
    """
    'fullstack' — all components in one lease/provider.
    'custom' — each component targeted individually via componentTargets.
    """
    mode: String!
    """Provider for fullstack mode ('akash' or 'phala'). Ignored in custom mode."""
    provider: String
    """Per-component provider assignments for custom mode."""
    componentTargets: [ComponentTargetInput!]
    """Which components to deploy (omit to deploy all). Required components are validated."""
    enabledComponentIds: [String!]
    """Override fallback values for disabled components (JSON: { componentId: { field: value } })."""
    componentFallbackOverrides: JSON
    serviceName: String
    envOverrides: [EnvOverrideInput!]
    resourceOverrides: ResourceOverrideInput
    policy: DeploymentPolicyInput
  }

  type CompositeDeploymentResult {
    primaryServiceId: ID!
    partialSuccess: Boolean
    failedComponents: [FailedComponentResult!]
    succeededComponents: [String!]
  }

  type FailedComponentResult {
    componentId: String!
    componentName: String!
    error: String!
  }

  # ============================================
  # QUERIES
  # ============================================

  type Query {
    # Version
    version: Version!

    # Templates
    templates(category: TemplateCategory): [Template!]!
    template(id: ID!): Template

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
    orgDomains(orgId: ID!): [Domain!]!

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

    # Domain Registration / Purchase
    checkDomainAvailability(input: CheckDomainAvailabilityInput!): [DomainAvailability!]!
    domainPricing(name: String!, extension: String!, operation: String, period: Int): DomainPricing!
    registeredDomains(limit: Int, offset: Int, status: String): RegisteredDomainList!

    # DNS Record Management (Admin)
    dnsRecords(domain: String!): [DNSRecord!]!
    dnsRecord(domain: String!, name: String!, type: DNSRecordType!): DNSRecord

    # Storage Analytics
    storageAnalytics(projectId: ID): StorageAnalytics!
    storageUsageTrend(projectId: ID, days: Int): [StorageUsageTrend!]!

    # Workspace Metrics (aggregated compute, storage, traffic)
    workspaceMetrics(projectId: ID): WorkspaceMetrics!

    # Unified Deployments (all deployment types across all services)
    allDeployments(projectId: ID, limit: Int): [UnifiedDeployment!]!

    # System Health
    subscriptionHealth: SubscriptionHealth!

    # Agent Chat
    agent(id: ID!): Agent
    agentBySlug(slug: String!): Agent
    agents: [Agent!]!
    chat(id: ID!): Chat
    chats: [Chat!]!
    messages(chatId: ID!, limit: Int, before: String): [Message!]!

    # Akash Deployments
    akashDeployment(id: ID!): AkashDeployment
    # List Akash deployments, optionally filtered by serviceId, functionId, or siteId
    akashDeployments(serviceId: ID, functionId: ID, siteId: ID): [AkashDeployment!]!
    # Get the active Akash deployment for a service
    akashDeploymentByService(serviceId: ID!): AkashDeployment
    # Legacy: Get the active Akash deployment for a function
    akashDeploymentByFunction(functionId: ID!): AkashDeployment

    # Phala Deployments
    phalaDeployment(id: ID!): PhalaDeployment
    phalaDeployments(serviceId: ID, projectId: ID): [PhalaDeployment!]!
    phalaDeploymentByService(serviceId: ID!): PhalaDeployment

    # Storage Tracking
    pinnedContent(limit: Int): [PinnedContent!]!
    storageSnapshots(
      startDate: Date
      endDate: Date
      limit: Int
    ): [StorageSnapshot!]!
    storageStats: StorageTrackingStats!

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

    # Live container health from provider (Akash lease-status / Phala CVM status)
    deploymentHealth(serviceId: ID!): DeploymentHealth

    # Service container logs (Akash / Phala)
    serviceLogs(serviceId: ID!, tail: Int, service: String): ServiceLogResult!

    # Service links (connections between services)
    serviceLinks(projectId: ID!): [ServiceLink!]!

    # Org billing runway (how long until funds run out)
    orgBillingRunway: OrgBillingRunway
  }

  type OrgBillingRunway {
    balanceCents: Int!
    totalDailyBurnCents: Int!
    runwayHours: Float
    runwayFormatted: String!
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

  input UpdateProjectDataInput {
    name: String
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
    updateProject(id: ID!, data: UpdateProjectDataInput!): Project!
    deleteProject(id: ID!): Boolean!

    # Services
    createService(input: CreateServiceInput!): Service!
    updateService(serviceId: ID!, input: UpdateServiceInput!): Service!
    updateServicePriority(serviceId: ID!, shutdownPriority: Int!): Service!

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
    deleteService(id: ID!): Service!

    # Domains
    createDomain(input: CreateDomainInput!): Domain!
    createOrgDomain(input: CreateOrgDomainInput!): Domain!
    assignDomainToSite(domainId: ID!, siteId: ID!): Domain!
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

    # Storage Tracking
    triggerStorageSnapshot: StorageSnapshot!

    # Observability Settings
    updateObservabilitySettings(
      projectId: ID!
      input: UpdateObservabilitySettingsInput!
    ): ObservabilitySettings!

    # Domain Registration / Purchase
    purchaseDomain(input: PurchaseDomainInput!): DomainRegistrationResult!

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

    # Templates
    deployFromTemplate(input: DeployFromTemplateInput!): AkashDeployment!
    deployFromTemplateToPhala(input: DeployFromTemplateInput!): PhalaDeployment!
    deployCompositeTemplate(input: DeployCompositeTemplateInput!): CompositeDeploymentResult!

    # Phala Deployments
    # General-purpose: deploy any service to Phala Cloud (TEE)
    deployToPhala(input: DeployToPhalaInput!): PhalaDeployment!
    stopPhalaDeployment(id: ID!): PhalaDeployment!
    deletePhalaDeployment(id: ID!): PhalaDeployment!

    # Service Environment Variables
    setServiceEnvVar(serviceId: ID!, key: String!, value: String!, secret: Boolean): ServiceEnvVar!
    deleteServiceEnvVar(serviceId: ID!, key: String!): Boolean!
    bulkSetServiceEnvVars(serviceId: ID!, vars: [EnvVarInput!]!): [ServiceEnvVar!]!

    # Service Port Configuration
    setServicePort(serviceId: ID!, containerPort: Int!, publicPort: Int, protocol: String): ServicePort!
    deleteServicePort(serviceId: ID!, containerPort: Int!): Boolean!

    # Service Linking
    linkServices(sourceServiceId: ID!, targetServiceId: ID!, alias: String): ServiceLink!
    unlinkServices(sourceServiceId: ID!, targetServiceId: ID!): Boolean!

    # Feedback
    submitFeedback(input: SubmitFeedbackInput!): FeedbackReport!
  }

  # ============================================
  # SUBSCRIPTIONS
  # ============================================

  type Subscription {
    deploymentLogs(deploymentId: ID!): DeploymentLog!
    deploymentStatus(deploymentId: ID!): DeploymentStatusUpdate!
  }
`
