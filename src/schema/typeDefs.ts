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

  type PersonalAccessToken {
    id: ID!
    name: String!
    token: String!
    expiresAt: Date
    lastUsedAt: Date
    createdAt: Date!
    updatedAt: Date!
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
    site: Site!
    createdAt: Date!
    updatedAt: Date!
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
  # QUERIES
  # ============================================

  type Query {
    # Version
    version: Version!

    # User & Auth
    me: User

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
    createPersonalAccessToken(name: String!): PersonalAccessToken!
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
    createDomain(hostname: String!, siteId: ID!): Domain!
    deleteDomain(id: ID!): Boolean!

    # Agent Chat
    createAgent(input: CreateAgentInput!): Agent!
    createChat(input: CreateChatInput!): Chat!
    sendMessage(input: SendMessageInput!): Message!
    deleteChat(id: ID!): Boolean!
  }

  # ============================================
  # SUBSCRIPTIONS
  # ============================================

  type Subscription {
    deploymentLogs(deploymentId: ID!): DeploymentLog!
    deploymentStatus(deploymentId: ID!): DeploymentStatusUpdate!
  }
`;
