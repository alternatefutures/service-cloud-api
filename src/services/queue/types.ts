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

// ── Progress event ────────────────────────────────────────────────────

export interface DeploymentProgressEvent {
  deploymentId: string
  provider: 'akash' | 'phala'
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

export const MAX_RETRY_COUNT = 3
export const BID_POLL_MAX_ATTEMPTS = 10
// Bumped from 24 → 60: large images (700MB+)
export const URL_POLL_MAX_ATTEMPTS = 60
export const PHALA_POLL_MAX_ATTEMPTS = 24
