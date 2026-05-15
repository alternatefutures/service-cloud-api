/**
 * QStash job step types and payloads for background deployment processing.
 */

// ── Akash deployment steps ────────────────────────────────────────────

export type AkashStep =
  | 'SUBMIT_TX'
  | 'CHECK_BIDS'
  | 'CREATE_LEASE'
  | 'SEND_MANIFEST'
  | 'POLL_URLS'
  | 'HANDLE_FAILURE'

export interface AkashSubmitTxPayload {
  step: 'SUBMIT_TX'
  deploymentId: string
}

export interface AkashCheckBidsPayload {
  step: 'CHECK_BIDS'
  deploymentId: string
  attempt: number
}

export interface AkashCreateLeasePayload {
  step: 'CREATE_LEASE'
  deploymentId: string
  provider: string
  gseq: number
  oseq: number
  priceAmount: string
}

export interface AkashSendManifestPayload {
  step: 'SEND_MANIFEST'
  deploymentId: string
}

export interface AkashPollUrlsPayload {
  step: 'POLL_URLS'
  deploymentId: string
  attempt: number
}

export interface AkashHandleFailurePayload {
  step: 'HANDLE_FAILURE'
  deploymentId: string
  errorMessage: string
}

export type AkashJobPayload =
  | AkashSubmitTxPayload
  | AkashCheckBidsPayload
  | AkashCreateLeasePayload
  | AkashSendManifestPayload
  | AkashPollUrlsPayload
  | AkashHandleFailurePayload

// ── Phala deployment steps ────────────────────────────────────────────

export type PhalaStep =
  | 'DEPLOY_CVM'
  | 'POLL_STATUS'
  | 'HANDLE_FAILURE'

export interface PhalaDeployCvmPayload {
  step: 'DEPLOY_CVM'
  deploymentId: string
}

export interface PhalaPollStatusPayload {
  step: 'POLL_STATUS'
  deploymentId: string
  attempt: number
}

export interface PhalaHandleFailurePayload {
  step: 'HANDLE_FAILURE'
  deploymentId: string
  errorMessage: string
}

export type PhalaJobPayload =
  | PhalaDeployCvmPayload
  | PhalaPollStatusPayload
  | PhalaHandleFailurePayload

// ── Spheron deployment steps ──────────────────────────────────────────
//
// Spheron lifecycle:
//   DEPLOY_VM            → POST /api/deployments (cloudInit lays down compose)
//   POLL_STATUS          → GET /api/deployments/{id} until status=running + ipAddress
//   RUN_CLOUDINIT_PROBE  → SSH-probe `docker ps` to confirm the workload came up
//                          (Spheron `running` only means VM is up, not the app).
//                          Splits out as its own step so transient SSH errors
//                          retry independently of VM provisioning.
//   HANDLE_FAILURE       → uniform failure path (mirrors phala/akash)
//
// v1 ships DEDICATED-only — SPOT (`status: terminated-provider`) is a
// reserved code path. The PROVIDER_INTERRUPTED policy stop reason exists in
// the schema but no step emits it yet.

export type SpheronStep =
  | 'DEPLOY_VM'
  | 'POLL_STATUS'
  | 'RUN_CLOUDINIT_PROBE'
  | 'HANDLE_FAILURE'

export interface SpheronDeployVmPayload {
  step: 'DEPLOY_VM'
  deploymentId: string
}

export interface SpheronPollStatusPayload {
  step: 'POLL_STATUS'
  deploymentId: string
  attempt: number
}

export interface SpheronRunCloudInitProbePayload {
  step: 'RUN_CLOUDINIT_PROBE'
  deploymentId: string
  attempt: number
}

export interface SpheronHandleFailurePayload {
  step: 'HANDLE_FAILURE'
  deploymentId: string
  errorMessage: string
}

export type SpheronJobPayload =
  | SpheronDeployVmPayload
  | SpheronPollStatusPayload
  | SpheronRunCloudInitProbePayload
  | SpheronHandleFailurePayload

// ── Policy runtime jobs ───────────────────────────────────────────────

export type PolicyStep = 'EXPIRE_POLICY'

export interface PolicyExpirePayload {
  step: 'EXPIRE_POLICY'
  policyId: string
  expectedExpiresAt: string
}

export type PolicyJobPayload = PolicyExpirePayload

// ── Progress event ────────────────────────────────────────────────────

export interface DeploymentProgressEvent {
  deploymentId: string
  provider: 'akash' | 'phala' | 'spheron'
  status: string
  step: string
  stepNumber: number
  totalSteps: number
  retryCount: number
  message: string
  errorMessage?: string
  timestamp: string
}

export const AKASH_TOTAL_STEPS = 6
export const PHALA_TOTAL_STEPS = 3
export const SPHERON_TOTAL_STEPS = 4

export const AKASH_STEP_NUMBERS: Record<AkashStep, number> = {
  SUBMIT_TX: 1,
  CHECK_BIDS: 2,
  CREATE_LEASE: 3,
  SEND_MANIFEST: 4,
  POLL_URLS: 5,
  HANDLE_FAILURE: 6,
}

export const PHALA_STEP_NUMBERS: Record<PhalaStep, number> = {
  DEPLOY_CVM: 1,
  POLL_STATUS: 2,
  HANDLE_FAILURE: 3,
}

export const SPHERON_STEP_NUMBERS: Record<SpheronStep, number> = {
  DEPLOY_VM: 1,
  POLL_STATUS: 2,
  RUN_CLOUDINIT_PROBE: 3,
  HANDLE_FAILURE: 4,
}

export const MAX_RETRY_COUNT = 3
export const BID_POLL_MAX_ATTEMPTS = 10
// Bumped from 24 → 60: large images (700MB+)
export const URL_POLL_MAX_ATTEMPTS = 60
// Bumped from 60 → 180: TDX CVMs pull Docker images inside the enclave; 3GB+ images can take 10-15 min
export const PHALA_POLL_MAX_ATTEMPTS = 180
// Spheron VM provisioning typically takes 30-90s; set generously for cold
// starts on cluster providers. Each attempt is 5s apart → ~10min ceiling.
export const SPHERON_POLL_MAX_ATTEMPTS = 120
// Post-boot SSH probe: cloudInit may install Docker, pull a 5GB image, run
// `docker compose up`. Spheron's own dashboard advertises "Available in 20m"
// for fresh GPU VMs (driver/firmware setup happens before our cloudInit even
// runs), so 5min was too aggressive — observed real failures with healthy
// upstream VMs that simply hadn't finished provisioning. 5s × 240 = 20min
// ceiling matches Spheron's stated ramp-up window.
export const SPHERON_CLOUDINIT_PROBE_MAX_ATTEMPTS = 240
