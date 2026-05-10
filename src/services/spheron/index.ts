/**
 * Spheron service barrel.
 *
 * Re-exports the orchestrator + cloudInit builder + typed client. Mirrors
 * `services/phala/index.ts` so callers `import … from '../spheron/index.js'`
 * uniformly.
 */

export {
  SpheronClient,
  SpheronApiError,
  getSpheronClient,
  resetSpheronClient,
  type SpheronInstanceType,
  type SpheronDeploymentNativeStatus,
  type SpheronTeam,
  type SpheronBalance,
  type SpheronGpuOffer,
  type SpheronGpuOfferGroup,
  type SpheronGpuOffersResponse,
  type SpheronGpuOffersFilters,
  type SpheronSshKey,
  type SpheronCloudInit,
  type SpheronCreateDeploymentInput,
  type SpheronDeploymentObject,
  type SpheronCanTerminateResponse,
  type SpheronDeleteResponse,
} from './client.js'

export {
  buildCloudInit,
  isDockerPreinstalled,
  renderEnvFile,
  CloudInitValidationError,
  type BuildCloudInitInput,
} from './cloudInit.js'

export {
  SpheronOrchestrator,
  getSpheronOrchestrator,
  resetSpheronOrchestrator,
  getSpheronSshKeyPath,
  type DeployServiceSpheronOptions,
  type DockerHealthSnapshot,
} from './orchestrator.js'

export {
  pickSpheronOffer,
  clusterMatchesBucket,
  NoSpheronCapacityError,
  type SpheronGpuConstraint,
  type PickOfferOptions,
  type PickedOffer,
} from './offerPicker.js'

export {
  canonicalizeSpheronGpuType,
  canonicalizeAkashSlug,
} from './canonicalize.js'
