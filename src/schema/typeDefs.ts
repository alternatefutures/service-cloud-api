export const typeDefs = /* GraphQL */ `
  # ============================================
  # SCALARS
  # ============================================

  scalar Date

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
    functions: [FleekFunction!]!
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
  }

  # ============================================
  # FUNCTIONS
  # ============================================

  type FleekFunction {
    id: ID!
    name: String!
    slug: String!
    invokeUrl: String
    status: FunctionStatus!
    project: Project!
    siteId: String
    currentDeployment: FleekFunctionDeployment
    deployments: [FleekFunctionDeployment!]!
    createdAt: Date!
    updatedAt: Date!
  }

  type FleekFunctionDeployment {
    id: ID!
    cid: String!
    blake3Hash: String
    assetsCid: String
    sgx: Boolean!
    fleekFunction: FleekFunction!
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
  # VERSION
  # ============================================

  type Version {
    commitHash: String!
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
    fleekFunctionByName(name: String!): FleekFunction
    fleekFunctions: [FleekFunction!]!
    fleekFunctionDeployment(id: ID!): FleekFunctionDeployment
    fleekFunctionDeployments(functionId: ID!): [FleekFunctionDeployment!]!

    # Domains
    domain(id: ID!): Domain
    domains(siteId: ID): [Domain!]!
    domainByHostname(hostname: String!): Domain

    # Storage Analytics
    storageAnalytics(projectId: ID): StorageAnalytics!
    storageUsageTrend(projectId: ID, days: Int): [StorageUsageTrend!]!
  }

  # ============================================
  # MUTATIONS
  # ============================================

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
    createDeployment(siteId: ID!, cid: String!): Deployment!

    # Functions
    createFleekFunction(name: String!, siteId: ID): FleekFunction!
    deployFleekFunction(
      functionId: ID!
      cid: String!
      sgx: Boolean
      blake3Hash: String
      assetsCid: String
    ): FleekFunctionDeployment!
    updateFleekFunction(
      id: ID!
      name: String
      slug: String
      status: FunctionStatus
    ): FleekFunction!
    deleteFleekFunction(id: ID!): Boolean!

    # Domains
    createDomain(hostname: String!, siteId: ID!): Domain!
    deleteDomain(id: ID!): Boolean!
  }
`;
