/**
 * af-builder Job spawner.
 *
 * Reads `infra/k8s/builder/job.template.yaml`, substitutes per-build env,
 * and creates the Job in the `alternatefutures-builds` namespace.
 *
 * In-cluster: uses the pod's mounted ServiceAccount token (the `af-builder-spawner`
 * SA has RBAC to manage Jobs in that namespace via `infra/k8s/builder/rbac.yaml`).
 * Local dev: uses the developer's `~/.kube/config`.
 *
 * Local dev without a cluster: set `BUILDER_DRY_RUN=1` to skip Job creation
 * and only persist the BuildJob row — useful for UI iteration.
 */

import * as k8s from '@kubernetes/client-node'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../../lib/logger.js'
import { getGithubAppConfig } from './config.js'
import { signBuildToken } from './buildToken.js'
import { buildCloneUrl } from './client.js'

const log = createLogger('github.buildSpawner')

const NAMESPACE = process.env.BUILDER_NAMESPACE || 'alternatefutures-builds'
const BUILDER_IMAGE =
  process.env.BUILDER_IMAGE || 'ghcr.io/alternatefutures/af-builder:latest'

const TEMPLATE_PATH = (() => {
  if (process.env.BUILDER_JOB_TEMPLATE_PATH) return process.env.BUILDER_JOB_TEMPLATE_PATH
  return path.resolve(process.cwd(), '../infra/k8s/builder/job.template.yaml')
})()

let cachedTemplate: string | null = null
function loadTemplate(): string {
  if (cachedTemplate) return cachedTemplate
  // Prefer disk so ops can hot-edit the template in dev, fall back to the
  // embedded constant so the api Docker image is self-contained (the infra/
  // dir lives in a sibling repo and isn't copied into the image).
  if (fs.existsSync(TEMPLATE_PATH)) {
    cachedTemplate = fs.readFileSync(TEMPLATE_PATH, 'utf8')
  } else {
    cachedTemplate = EMBEDDED_TEMPLATE
  }
  return cachedTemplate
}

// Keep in sync with infra/k8s/builder/job.template.yaml. Edited there is the
// canonical source; this constant is a build-time snapshot for prod.
const EMBEDDED_TEMPLATE = `apiVersion: batch/v1
kind: Job
metadata:
  name: __JOB_NAME__
  namespace: __NAMESPACE__
  labels:
    app: af-builder
    af.io/build-job-id: "__BUILD_JOB_ID__"
spec:
  ttlSecondsAfterFinished: 3600
  backoffLimit: 0
  activeDeadlineSeconds: 1800
  template:
    metadata:
      labels:
        app: af-builder
        af.io/build-job-id: "__BUILD_JOB_ID__"
    spec:
      restartPolicy: Never
      shareProcessNamespace: true
      automountServiceAccountToken: false
      containers:
        - name: dind
          image: docker:24-dind
          imagePullPolicy: IfNotPresent
          securityContext:
            privileged: true
          args:
            - "--host=tcp://0.0.0.0:2375"
            - "--tls=false"
          env:
            - name: DOCKER_TLS_CERTDIR
              value: ""
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
          volumeMounts:
            - name: dind-storage
              mountPath: /var/lib/docker
            - name: workspace
              mountPath: /workspace
          readinessProbe:
            tcpSocket:
              port: 2375
            initialDelaySeconds: 5
            periodSeconds: 3
            failureThreshold: 30
        - name: builder
          image: __BUILDER_IMAGE__
          imagePullPolicy: Always
          env:
            - name: DOCKER_HOST
              value: "tcp://localhost:2375"
            - name: BUILD_JOB_ID
              value: "__BUILD_JOB_ID__"
            - name: CALLBACK_URL
              value: "__CALLBACK_URL__"
            - name: CALLBACK_TOKEN
              value: "__CALLBACK_TOKEN__"
            - name: REPO_CLONE_URL
              value: "__REPO_CLONE_URL__"
            - name: REPO_REF
              value: "__REPO_REF__"
            - name: IMAGE_TAG
              value: "__IMAGE_TAG__"
            - name: GHCR_USER
              value: "__GHCR_USER__"
            - name: GHCR_TOKEN
              value: "__GHCR_TOKEN__"
            - name: ROOT_DIRECTORY
              value: "__ROOT_DIRECTORY__"
            - name: BUILD_COMMAND_B64
              value: "__BUILD_COMMAND_B64__"
            - name: START_COMMAND_B64
              value: "__START_COMMAND_B64__"
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
            limits:
              cpu: "2"
              memory: "4Gi"
          volumeMounts:
            - name: workspace
              mountPath: /workspace
      volumes:
        - name: dind-storage
          emptyDir: {}
        - name: workspace
          emptyDir: {}
`

let cachedKc: k8s.KubeConfig | null = null
function getKubeClient(): k8s.BatchV1Api {
  if (!cachedKc) {
    cachedKc = new k8s.KubeConfig()
    if (process.env.KUBERNETES_SERVICE_HOST) {
      cachedKc.loadFromCluster()
    } else {
      cachedKc.loadFromDefault()
    }
  }
  return cachedKc.makeApiClient(k8s.BatchV1Api)
}

export interface SpawnBuildInput {
  buildJobId: string
  installationId: bigint | string
  repoOwner: string
  repoName: string
  /** Full commit SHA — REQUIRED, pin builds to immutable refs. */
  commitSha: string
  /** Where the resulting image gets pushed (ghcr.io/<ns>/<userid>--<repo>:<sha>). */
  imageTag: string
  rootDirectory?: string
  buildCommand?: string
  startCommand?: string
  /** Override for the callback base URL. Defaults to API_BASE_URL or api.alternatefutures.ai. */
  callbackBaseUrl?: string
}

export interface SpawnedBuildJob {
  k8sJobName: string
  /** True only when BUILDER_DRY_RUN=1 — used by tests + local dev. */
  dryRun: boolean
}

export async function spawnBuildJob(input: SpawnBuildInput): Promise<SpawnedBuildJob> {
  const cfg = getGithubAppConfig()
  const cloneUrl = await buildCloneUrl(input.installationId, input.repoOwner, input.repoName)
  const callbackBase =
    input.callbackBaseUrl || process.env.API_BASE_URL || 'https://api.alternatefutures.ai'
  const callbackUrl = `${callbackBase.replace(/\/$/, '')}/internal/build-callback`
  const callbackToken = signBuildToken(input.buildJobId)

  const jobName = `build-${input.buildJobId.toLowerCase()}`.slice(0, 63)

  const yaml = loadTemplate()
    .replaceAll('__JOB_NAME__', jobName)
    .replaceAll('__NAMESPACE__', NAMESPACE)
    .replaceAll('__BUILDER_IMAGE__', BUILDER_IMAGE)
    .replaceAll('__BUILD_JOB_ID__', input.buildJobId)
    .replaceAll('__CALLBACK_URL__', callbackUrl)
    .replaceAll('__CALLBACK_TOKEN__', callbackToken)
    // YAML strings are double-quoted in the template; embed-safely escape
    // the few characters that could break out (`"` and `\`).
    .replaceAll('__REPO_CLONE_URL__', escapeYamlValue(cloneUrl))
    .replaceAll('__REPO_REF__', input.commitSha)
    .replaceAll('__IMAGE_TAG__', input.imageTag)
    .replaceAll('__GHCR_USER__', cfg.ghcrUser)
    .replaceAll('__GHCR_TOKEN__', escapeYamlValue(cfg.ghcrPushToken))
    .replaceAll('__ROOT_DIRECTORY__', input.rootDirectory || '.')
    .replaceAll('__BUILD_COMMAND_B64__', input.buildCommand ? toB64(input.buildCommand) : '')
    .replaceAll('__START_COMMAND_B64__', input.startCommand ? toB64(input.startCommand) : '')

  if (process.env.BUILDER_DRY_RUN === '1') {
    log.warn({ jobName, buildJobId: input.buildJobId }, 'BUILDER_DRY_RUN=1 — skipping K8s create')
    return { k8sJobName: jobName, dryRun: true }
  }

  const parsed = k8s.loadYaml<k8s.V1Job>(yaml)
  const api = getKubeClient()
  try {
    await api.createNamespacedJob({ namespace: NAMESPACE, body: parsed })
  } catch (err: unknown) {
    log.error({ err, jobName }, 'failed to create builder Job')
    throw new Error(`builder spawn failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  log.info({ jobName, buildJobId: input.buildJobId }, 'builder Job created')
  return { k8sJobName: jobName, dryRun: false }
}

/** Best-effort delete of a builder Job (used on cancel + manual cleanup). */
export async function deleteBuildJob(k8sJobName: string): Promise<void> {
  if (process.env.BUILDER_DRY_RUN === '1') return
  try {
    const api = getKubeClient()
    await api.deleteNamespacedJob({
      name: k8sJobName,
      namespace: NAMESPACE,
      propagationPolicy: 'Background',
    })
  } catch (err) {
    log.warn({ err, k8sJobName }, 'failed to delete builder Job (already gone?)')
  }
}

function escapeYamlValue(v: string): string {
  return v.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function toB64(v: string): string {
  return Buffer.from(v, 'utf8').toString('base64')
}
