/**
 * af-builder spawner — dispatches a BuildJob to one of two backends:
 *
 *   - `k8s` (default): renders `infra/k8s/builder/job.template.yaml`,
 *     creates a Job in `alternatefutures-builds`. The pod runs the
 *     builder container alongside a privileged `docker:24-dind`
 *     sidecar over a shared process namespace.
 *
 *   - `fly`: spawns a single ephemeral Fly Machine running the
 *     `service-builder` Fly variant (`Dockerfile.fly`) which embeds
 *     `dockerd` in-VM. Pay-per-second, auto-destroying, fully
 *     isolated from our cluster. See `flyioBuilder.ts`.
 *
 * The active backend is selected via `BUILD_EXECUTOR=k8s|fly` (default
 * `k8s` for safe rollback). The callback URL, HMAC token, env contract,
 * and BuildJob row lifecycle are byte-identical across backends — this
 * file is the only place that knows the difference.
 *
 * In-cluster (K8s path): uses the pod's mounted ServiceAccount token
 * (the `af-builder-spawner` SA has RBAC to manage Jobs in the builds
 * namespace via `infra/k8s/builder/rbac.yaml`).
 * Local dev: uses the developer's `~/.kube/config`.
 *
 * Local dev without a cluster (any backend): set `BUILDER_DRY_RUN=1`
 * to skip the spawn and only persist the BuildJob row — useful for
 * UI iteration.
 */

import * as k8s from '@kubernetes/client-node'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../../lib/logger.js'
import { getGithubAppConfig } from './config.js'
import { signBuildToken } from './buildToken.js'
import { buildCloneUrl } from './client.js'
import { destroyFlyMachine, spawnFlyBuilder } from './flyioBuilder.js'

const log = createLogger('github.buildSpawner')

type BuildExecutor = 'k8s' | 'fly'

/** `fly:<machine_id>` for Fly machines, raw `build-<jobid>` for K8s Jobs.
 *  Stored verbatim into BuildJob.k8sJobName so deleteBuildJob can route. */
const FLY_PREFIX = 'fly:'

function getExecutor(): BuildExecutor {
  const raw = (process.env.BUILD_EXECUTOR || 'k8s').toLowerCase()
  if (raw === 'fly' || raw === 'flyio' || raw === 'fly.io') return 'fly'
  return 'k8s'
}

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
  /**
   * Identifier we persist into `BuildJob.k8sJobName`. Despite the
   * historical column name, this can be either a K8s Job name
   * (`build-<jobId>`) OR a prefixed Fly machine handle
   * (`fly:<machineId>`). `deleteBuildJob` routes on the prefix.
   */
  k8sJobName: string
  /** True only when BUILDER_DRY_RUN=1 — used by tests + local dev. */
  dryRun: boolean
  /** Which backend actually ran the build. Mirrored into logs/metrics. */
  executor: BuildExecutor
}

/** Shared env contract for both K8s and Fly. The keys exactly match the
 *  variables `service-builder/scripts/build.sh` reads. */
function buildEnvFor(
  input: SpawnBuildInput,
  cloneUrl: string,
  callbackUrl: string,
  callbackToken: string,
): Record<string, string> {
  const cfg = getGithubAppConfig()
  return {
    BUILD_JOB_ID: input.buildJobId,
    CALLBACK_URL: callbackUrl,
    CALLBACK_TOKEN: callbackToken,
    REPO_CLONE_URL: cloneUrl,
    REPO_REF: input.commitSha,
    IMAGE_TAG: input.imageTag,
    GHCR_USER: cfg.ghcrUser,
    GHCR_TOKEN: cfg.ghcrPushToken,
    ROOT_DIRECTORY: input.rootDirectory || '.',
    BUILD_COMMAND_B64: input.buildCommand ? toB64(input.buildCommand) : '',
    START_COMMAND_B64: input.startCommand ? toB64(input.startCommand) : '',
  }
}

export async function spawnBuildJob(input: SpawnBuildInput): Promise<SpawnedBuildJob> {
  const cloneUrl = await buildCloneUrl(input.installationId, input.repoOwner, input.repoName)
  const callbackBase =
    input.callbackBaseUrl || process.env.API_BASE_URL || 'https://api.alternatefutures.ai'
  const callbackUrl = `${callbackBase.replace(/\/$/, '')}/internal/build-callback`
  const callbackToken = signBuildToken(input.buildJobId)

  const jobName = `build-${input.buildJobId.toLowerCase()}`.slice(0, 63)
  const env = buildEnvFor(input, cloneUrl, callbackUrl, callbackToken)
  const executor = getExecutor()

  if (process.env.BUILDER_DRY_RUN === '1') {
    log.warn(
      { jobName, buildJobId: input.buildJobId, executor },
      'BUILDER_DRY_RUN=1 — skipping spawn',
    )
    return { k8sJobName: jobName, dryRun: true, executor }
  }

  if (executor === 'fly') {
    try {
      const result = await spawnFlyBuilder({ name: jobName, env })
      log.info(
        { machineId: result.machineId, jobName, buildJobId: input.buildJobId, region: result.region },
        'Fly builder machine launched',
      )
      return { k8sJobName: `${FLY_PREFIX}${result.machineId}`, dryRun: false, executor }
    } catch (err) {
      log.error(
        { err, jobName, buildJobId: input.buildJobId },
        'Fly builder spawn failed — falling back to K8s',
      )
      // Fall through to the K8s path so a Fly outage during cutover
      // doesn't block builds entirely. Operators can disable the
      // fallback by setting `BUILD_EXECUTOR_NO_FALLBACK=1`.
      if (process.env.BUILD_EXECUTOR_NO_FALLBACK === '1') {
        throw new Error(
          `Fly builder spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  return spawnK8sBuilderJob({ jobName, env, buildJobId: input.buildJobId })
}

function renderK8sJobYaml(args: { jobName: string; env: Record<string, string> }): string {
  return loadTemplate()
    .replaceAll('__JOB_NAME__', args.jobName)
    .replaceAll('__NAMESPACE__', NAMESPACE)
    .replaceAll('__BUILDER_IMAGE__', BUILDER_IMAGE)
    .replaceAll('__BUILD_JOB_ID__', args.env.BUILD_JOB_ID)
    .replaceAll('__CALLBACK_URL__', args.env.CALLBACK_URL)
    .replaceAll('__CALLBACK_TOKEN__', args.env.CALLBACK_TOKEN)
    // YAML strings are double-quoted in the template; embed-safely escape
    // the few characters that could break out (`"` and `\`).
    .replaceAll('__REPO_CLONE_URL__', escapeYamlValue(args.env.REPO_CLONE_URL))
    .replaceAll('__REPO_REF__', args.env.REPO_REF)
    .replaceAll('__IMAGE_TAG__', args.env.IMAGE_TAG)
    .replaceAll('__GHCR_USER__', args.env.GHCR_USER)
    .replaceAll('__GHCR_TOKEN__', escapeYamlValue(args.env.GHCR_TOKEN))
    .replaceAll('__ROOT_DIRECTORY__', args.env.ROOT_DIRECTORY)
    .replaceAll('__BUILD_COMMAND_B64__', args.env.BUILD_COMMAND_B64)
    .replaceAll('__START_COMMAND_B64__', args.env.START_COMMAND_B64)
}

async function spawnK8sBuilderJob(args: {
  jobName: string
  env: Record<string, string>
  buildJobId: string
}): Promise<SpawnedBuildJob> {
  const yaml = renderK8sJobYaml({ jobName: args.jobName, env: args.env })
  const parsed = k8s.loadYaml<k8s.V1Job>(yaml)
  const api = getKubeClient()
  try {
    await api.createNamespacedJob({ namespace: NAMESPACE, body: parsed })
  } catch (err: unknown) {
    log.error({ err, jobName: args.jobName }, 'failed to create builder Job')
    throw new Error(`builder spawn failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  log.info({ jobName: args.jobName, buildJobId: args.buildJobId }, 'builder Job created')
  return { k8sJobName: args.jobName, dryRun: false, executor: 'k8s' }
}

/**
 * Best-effort cancel of an in-flight build. Routes to the right backend
 * based on the prefix we wrote in `spawnBuildJob` (Fly machines carry
 * the `fly:` prefix; raw K8s job names do not).
 */
export async function deleteBuildJob(k8sJobName: string): Promise<void> {
  if (process.env.BUILDER_DRY_RUN === '1') return

  if (k8sJobName.startsWith(FLY_PREFIX)) {
    const machineId = k8sJobName.slice(FLY_PREFIX.length)
    await destroyFlyMachine(machineId)
    return
  }

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

/**
 * Escape a string for safe interpolation into a YAML double-quoted scalar.
 *
 * The values currently passing through (GitHub install tokens, GHCR PATs,
 * a templated clone URL) cannot in practice contain control chars — but
 * defense-in-depth is cheap, and someone WILL eventually pipe a user-
 * supplied value through here without re-reading this comment. Escape
 * `\\`, `"`, and the three control chars that actually break YAML scalar
 * parsing. We don't reach for js-yaml because we own the template, this
 * single helper, and know the surrounding context is always `"…"`.
 */
function escapeYamlValue(v: string): string {
  return v
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')
    .replaceAll('\t', '\\t')
}

function toB64(v: string): string {
  return Buffer.from(v, 'utf8').toString('base64')
}
