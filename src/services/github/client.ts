/**
 * Thin typed wrappers over the GitHub REST API used by service-cloud-api.
 *
 * We intentionally do NOT pull in `@octokit/rest` — we make ~6 calls and
 * don't need 200KB of generated client code. Raw fetch + a tiny shape per
 * endpoint keeps deps lean and the wire format obvious in PR diffs.
 */

import { getAppJwt, getInstallationToken } from './app.js'

const GH = 'https://api.github.com'

interface GhFetchOpts {
  /** Auth via App JWT (for `/app/...` endpoints) vs installation token. */
  auth: 'app-jwt' | { installationId: bigint | string }
  query?: Record<string, string | number | undefined>
}

async function gh<T>(path: string, opts: GhFetchOpts): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'AlternateFutures',
  }
  if (opts.auth === 'app-jwt') {
    headers.Authorization = `Bearer ${getAppJwt()}`
  } else {
    const token = await getInstallationToken(opts.auth.installationId)
    headers.Authorization = `Bearer ${token}`
  }

  let url = `${GH}${path}`
  if (opts.query) {
    const q = Object.entries(opts.query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&')
    if (q) url += `${path.includes('?') ? '&' : '?'}${q}`
  }

  const r = await fetch(url, { headers })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new GithubApiError(r.status, `${r.status} ${path}: ${body.slice(0, 200)}`)
  }
  return (await r.json()) as T
}

export class GithubApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'GithubApiError'
  }
}

// -----------------------------------------------------------------------
// Types — narrowed to only the fields we use.
// -----------------------------------------------------------------------

export interface GhInstallation {
  id: number
  account:
    | { login: string; id: number; type: 'User' }
    | { login: string; id: number; type: 'Organization' }
  repository_selection: 'all' | 'selected'
  suspended_at: string | null
}

export interface GhRepo {
  id: number
  name: string
  full_name: string
  owner: { login: string }
  private: boolean
  default_branch: string
  description: string | null
  pushed_at: string | null
  language: string | null
  html_url: string
}

export interface GhBranch {
  name: string
  commit: { sha: string }
  protected: boolean
}

export interface GhCommit {
  sha: string
  commit: { message: string; author: { name: string; email: string; date: string } }
}

// -----------------------------------------------------------------------
// Endpoints
// -----------------------------------------------------------------------

/** GET /app/installations — list every install of this App across all accounts. */
export async function listAllInstallations(): Promise<GhInstallation[]> {
  // App JWT auth. Paginated; we fetch up to 100 (we'll never realistically
  // have more for a single org's UI).
  return gh<GhInstallation[]>('/app/installations?per_page=100', { auth: 'app-jwt' })
}

/** GET /app/installations/{id} — single install metadata. */
export async function getInstallation(installationId: bigint | string): Promise<GhInstallation> {
  return gh<GhInstallation>(`/app/installations/${installationId}`, { auth: 'app-jwt' })
}

/** GET /installation/repositories — repos this install can access. */
export async function listInstallationRepos(
  installationId: bigint | string,
): Promise<GhRepo[]> {
  // Paginate up to 5 pages (500 repos). Stops early when GitHub returns < per_page.
  const repos: GhRepo[] = []
  for (let page = 1; page <= 5; page++) {
    const data = await gh<{ total_count: number; repositories: GhRepo[] }>(
      `/installation/repositories?per_page=100&page=${page}`,
      { auth: { installationId } },
    )
    repos.push(...data.repositories)
    if (data.repositories.length < 100) break
  }
  return repos
}

/** GET /repos/{owner}/{repo}/branches — list branches (used in branch picker). */
export async function listRepoBranches(
  installationId: bigint | string,
  owner: string,
  repo: string,
): Promise<GhBranch[]> {
  return gh<GhBranch[]>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`,
    { auth: { installationId } },
  )
}

/** GET /repos/{owner}/{repo} — used to confirm default branch + repo metadata. */
export async function getRepo(
  installationId: bigint | string,
  owner: string,
  repo: string,
): Promise<GhRepo> {
  return gh<GhRepo>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    { auth: { installationId } },
  )
}

/**
 * GET /repos/{owner}/{repo}/commits/{ref} — resolve branch name → commit SHA
 * so we always pin builds to an immutable ref.
 */
export async function getCommit(
  installationId: bigint | string,
  owner: string,
  repo: string,
  ref: string,
): Promise<GhCommit> {
  return gh<GhCommit>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
    { auth: { installationId } },
  )
}

/**
 * POST /repos/{owner}/{repo}/statuses/{sha} — write the green/red checkmark
 * shown on the commit / PR.
 */
export async function postCommitStatus(
  installationId: bigint | string,
  owner: string,
  repo: string,
  sha: string,
  body: {
    state: 'pending' | 'success' | 'failure' | 'error'
    target_url?: string
    description?: string
    /** Distinct context per check; ours is always 'alternatefutures/deploy'. */
    context?: string
  },
): Promise<void> {
  const token = await getInstallationToken(installationId)
  const r = await fetch(
    `${GH}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/statuses/${encodeURIComponent(sha)}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'AlternateFutures',
      },
      body: JSON.stringify({ context: 'alternatefutures/deploy', ...body }),
    },
  )
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new GithubApiError(r.status, `commit status: ${r.status}: ${text.slice(0, 200)}`)
  }
}

/**
 * Build the HTTPS clone URL embedding a freshly-minted installation token.
 *   https://x-access-token:<token>@github.com/<owner>/<repo>.git
 */
export async function buildCloneUrl(
  installationId: bigint | string,
  owner: string,
  repo: string,
): Promise<string> {
  const token = await getInstallationToken(installationId)
  return `https://x-access-token:${token}@github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`
}
