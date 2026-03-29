# Template Protocol

How templates work and how to add new ones.

## Architecture

```
Backend (service-cloud-api)              Frontend (web-app)
─────────────────────────────            ──────────────────
definitions/<id>.ts                      template-icons.tsx
       ↓                                        ↑
definitions/index.ts  (re-export)        services/templates/types.ts
       ↓                                        ↑
registry.ts           (array + Map)      services/templates/queries.ts
       ↓                                        ↑  (graphqlFetch)
resolvers/templates.ts                   ─────────
       ↓                                 GraphQL
schema/typeDefs.ts                       ─────────
```

Templates are **static TypeScript objects** — no database. The backend registry serves them via GraphQL. The frontend fetches them server-side (SSR) and passes them as props.

## How to add a new template

### Prerequisites — Docker image

Before adding a template, the Docker image must be accessible. There are three scenarios:

| Source | What to do |
|--------|-----------|
| **Public Docker Hub image** (e.g. `postgres:16-alpine`, `redis:7-alpine`) | Nothing — just reference it in `dockerImage`. |
| **Existing GHCR image** (e.g. `ghcr.io/org/repo:latest`) | Verify it exists and is public (or your Akash nodes can pull it). |
| **You need to build & push** | See [Building a Docker image](#building-a-docker-image) below. |

### Step 1 — Backend definition

Create `service-cloud-api/src/templates/definitions/<id>.ts`:

```typescript
import type { Template } from '../schema.js'

export const myService: Template = {
  // REQUIRED
  id: 'my-service',                    // Unique slug, used as Map key
  name: 'My Service',                  // Display name
  description: 'One sentence.',        // Shows in card + config sheet
  category: 'WEB_SERVER',              // See TemplateCategory below
  tags: ['web', 'http'],               // Searchable, first 4 shown on card
  icon: '🌐',                          // Emoji OR https URL to an image
  repoUrl: 'https://github.com/...',   // Link shown in config sheet
  dockerImage: 'nginx:alpine',         // Docker Hub or GHCR image
  serviceType: 'VM',                   // Maps to Service.type in DB

  // Set to true to show in the Featured carousel on the Add Service page
  featured: false,

  envVars: [
    {
      key: 'PORT',
      default: '80',                   // null = no default (user must fill)
      description: 'Listen port',
      required: true,
      secret: false,                   // true = password input in UI
    },
  ],

  resources: {
    cpu: 0.5,                          // CPU units (float)
    memory: '512Mi',                   // Must include unit
    storage: '1Gi',                    // Ephemeral storage
  },

  ports: [
    { port: 80, as: 80, global: true },  // global = publicly exposed
  ],

  // OPTIONAL
  healthCheck: { path: '/health', port: 80 },
  persistentStorage: [
    { name: 'data', size: '10Gi', mountPath: '/data' },
  ],
  pricingUakt: 1000,                   // Akash pricing per block
  startCommand: 'nginx -g "daemon off;"',
}
```

### Step 2 — Register in barrel export

Add to `definitions/index.ts`:

```typescript
export { myService } from './my-service.js'
```

### Step 3 — Add to registry

In `registry.ts`, import and add to the array. **Order matters** — templates appear in this order in the UI. Featured templates go first.

```typescript
import { myService } from './definitions/index.js'

const templates: Template[] = [
  // ... existing
  myService,
]
```

That's it for the backend. The GraphQL layer auto-serves it.

### Step 4 — Frontend icon

In `web-app/components/templates/template-icons.tsx`, add a case:

```typescript
import { SiNginx } from 'react-icons/si';

case 'my-service':
  return <SiNginx className={`${sizeClass} text-green-600`} />;
```

If the template's `icon` field is a URL (starts with `http`), it's rendered as an `<img>` tag automatically — no switch case needed.

If no matching icon case exists and icon is not a URL, `FaBox` (gray) is used as fallback.

## Building a Docker image

When adding a template for a project that doesn't have a published Docker image yet:

### 1. Check the project for a Dockerfile

Most projects have a Dockerfile in the repo root or a `deploy/` directory. Common locations:
- `Dockerfile`
- `deploy/Dockerfile`
- `docker/Dockerfile`
- `.docker/Dockerfile`

**Important:** Dockerfiles can be stale — always verify the `COPY` statements match the actual project structure before building. Common issues:
- References to directories that have been renamed or removed (e.g. `ui/` → `apps/app/`)
- References to files that don't exist (e.g. `patches/`, `.npmrc`, `bun.lock`)
- Lockfile mismatches (project uses `pnpm-lock.yaml` but Dockerfile expects `bun.lock`)

### 2. Build the image

```bash
cd /path/to/project
docker build -f deploy/Dockerfile -t ghcr.io/<org>/<repo>:latest .
```

### 3. Push to GHCR

```bash
# Login (needs a PAT with write:packages scope)
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <username> --password-stdin

# Push
docker push ghcr.io/<org>/<repo>:latest
```

**Permission requirements:**
- The GitHub PAT must have `write:packages` scope
- You must have write access to the org/repo on GitHub
- For org packages, the org may need to grant you package write permissions separately

### 4. Make the package public (if needed)

By default GHCR packages are private. Go to:
`https://github.com/orgs/<org>/packages/container/<repo>/settings`
and set visibility to Public, or configure your Akash deployment to use image pull credentials.

## When you need a wrapper image

Sometimes a third-party app's published Docker image doesn't work on Akash out of the box. You need a **wrapper image** when any of the following apply:

| Situation | Why a wrapper is needed |
|-----------|------------------------|
| Akash persistent volumes mount as root-owned | App runs as non-root user and can't write to the volume without `chown` at boot |
| The app has a UI (dashboard) but the default CMD only starts an API server | Need a static file server + reverse proxy on a single port |
| The base image bakes in auth tokens or config that blocks first-run access | Need to strip/override those files at build time |
| The upstream Dockerfile CMD is stale or broken | Need to provide the correct startup command |

### Decision flow: direct image vs wrapper

```
Can you deploy the upstream image directly on Akash?
  │
  ├─ YES: uses a single port, no persistent storage permission issues,
  │       CMD works, no hardcoded secrets → use the image directly.
  │       Set `startCommand` in the template if you need to override CMD.
  │
  └─ NO: → Build a wrapper image.
```

### Wrapper image pattern

Most wrapper images live in `service-cloud-api/docker/<name>-akash/` (e.g. OpenClaw). Milady uses `docker/milady-runtime/` (same pattern: chown + UI proxy + API; works on Akash and Phala). Reference implementation: `docker/milady-runtime/`.

```
docker/<name>-akash/
  ├── Dockerfile          # FROM base image, adds entrypoint + extras
  ├── entrypoint.sh       # Boot script: chown, privilege drop, start processes
  └── serve-with-ui.mjs   # (optional) Static file server + API reverse proxy
```

### Dockerfile rules

```dockerfile
FROM ghcr.io/<org>/<base-image>:latest

# 1. Switch to root for setup
USER root

# 2. Install privilege-drop tool (Debian = gosu, Alpine = su-exec)
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gosu && \
    rm -rf /var/lib/apt/lists/*
# Alpine alternative: RUN apk add --no-cache su-exec

# 3. Strip any baked-in secrets or config that blocks first-run access
RUN sed -i '/^SOME_TOKEN=/d' /app/.env 2>/dev/null || true

# 4. Copy entrypoint and any helper scripts
COPY docker/<name>-akash/entrypoint.sh /usr/local/bin/<name>-akash-entrypoint
RUN chmod +x /usr/local/bin/<name>-akash-entrypoint

# 5. Set ENTRYPOINT (not CMD) so it always runs at boot
ENTRYPOINT ["/usr/local/bin/<name>-akash-entrypoint"]

# 6. CMD must be empty array (not omitted) when entrypoint manages everything
CMD []
```

### Entrypoint rules (POSIX shell)

These rules come from real production incidents. Violating any of them **will** cause the container to crash-loop on Akash.

1. **Use `#!/usr/bin/env sh` and write POSIX-only shell.** Debian base images map `sh` to `dash`, not `bash`. The following are **bash-only and will break**: `wait -n`, `[[ ]]`, `<<<`, arrays, `source`, `function` keyword.

2. **Re-exec the script itself after privilege drop** — not `$@`:
   ```sh
   # CORRECT: re-exec this script as the non-root user
   exec gosu node "$0" "$@"

   # WRONG: runs $@ which is empty when CMD is []
   exec gosu node "$@"
   ```

3. **Guard the privilege-drop block** so the re-exec doesn't loop:
   ```sh
   if [ "$(id -u)" = "0" ]; then
     chown -R 1000:1000 "$STATE_DIR" 2>/dev/null || true
     exec gosu node "$0" "$@"
   fi
   # Everything below runs as non-root
   ```

4. **For multi-process entrypoints** (API + UI server), use background jobs + `trap` + POSIX `wait`:
   ```sh
   node /app/server.mjs start &
   API_PID=$!

   sleep 3  # let API initialize

   node /usr/local/bin/serve-with-ui.mjs &
   UI_PID=$!

   cleanup() {
     kill "$UI_PID" 2>/dev/null || true
     kill "$API_PID" 2>/dev/null || true
     wait 2>/dev/null || true
     exit 0
   }
   trap cleanup TERM INT

   # POSIX wait (no -n flag!) — blocks until ALL children exit
   wait
   ```

5. **Always test locally before pushing**: `docker run --rm -p 8080:2138 <image>`. If it exits immediately, fix it before deploying to Akash.

### Serving a UI alongside an API (single-port pattern)

Many apps (Milady, OpenClaw) have a React/Vite dashboard that the API server doesn't serve in production mode. On Akash you typically expose **one port** per service. The solution:

- The API listens on an **internal port** (e.g. `31337`) — not exposed.
- A lightweight Node.js server (`serve-with-ui.mjs`) listens on the **public port** (e.g. `2138`):
  - Serves the built UI static files (`/app/apps/app/dist/`) with SPA fallback
  - Proxies `/api/*` requests to `127.0.0.1:INTERNAL_PORT`
  - Proxies WebSocket upgrades on `/ws` to `127.0.0.1:INTERNAL_PORT`

Reference: `docker/milady-runtime/serve-with-ui.mjs`

Key env vars for this pattern:
```
MILADY_INTERNAL_API_PORT=31337   # internal, not exposed
MILADY_PORT=2138                 # public, exposed in SDL
MILADY_API_BIND=0.0.0.0          # MUST be 0.0.0.0, not 127.0.0.1
```

### Image tagging for Akash

**Never use mutable tags** (`:latest`, `:main`) in production on Akash. Providers cache images by tag and will not pull a new image even if you push an update.

- Use **versioned tags**: `:v1`, `:v2`, `:v3`, etc.
- Update `dockerImage` in the template definition whenever you push a new version.
- If you must redeploy with the same tag, you need a **different provider** or a full close + redeploy.

### Auditing the upstream image before wrapping

Before building a wrapper, verify these things about the base image:

- [ ] **CMD actually works**: `docker run --rm <base-image>` — does it start? Many repos have stale Dockerfiles where the CMD references removed commands or old paths.
- [ ] **Bind address**: Does the app default to `127.0.0.1` (container-only) or `0.0.0.0` (externally reachable)? If `127.0.0.1`, you must override via env var or the service will be unreachable on Akash.
- [ ] **Hardcoded secrets/tokens**: Check for `.env` files baked into the image that set auth tokens. These block dashboard access on first deploy. Strip them in the wrapper Dockerfile.
- [ ] **Which port(s) the app actually listens on**: Don't trust `EXPOSE` in the Dockerfile — check the app's actual config/code. The port in your template `ports` array must match.
- [ ] **Runs as root or non-root**: If non-root (e.g. `USER node`), Akash persistent volumes (mounted as root) will cause permission errors unless the wrapper `chown`s them.

### Wrapper image checklist

- [ ] Base image builds and runs locally (`docker run --rm`)
- [ ] Wrapper Dockerfile: privilege drop tool installed (`gosu` or `su-exec`)
- [ ] Wrapper Dockerfile: baked-in secrets stripped
- [ ] Entrypoint: POSIX `sh` only (no bash-isms)
- [ ] Entrypoint: re-execs `"$0"` after privilege drop (not `"$@"`)
- [ ] Entrypoint: `wait` (no `-n`) for multi-process
- [ ] If app has a UI: `serve-with-ui.mjs` pattern implemented
- [ ] Tested locally: `docker run --rm -p 8080:<public-port> <wrapper-image>`
- [ ] If image uses Bun workspaces: also tested locally with `docker run --platform linux/amd64 ...` to verify runtime package resolution (Docker `COPY` flattens workspace symlinks; Bun may keep deps in per-package `node_modules`)
- [ ] Pushed with a **versioned tag** (`:v1`, not `:latest`)
- [ ] Template definition: `dockerImage` points to the versioned tag
- [ ] Template definition: **no** `startCommand` (entrypoint handles everything)
- [ ] Template definition: `MILADY_API_BIND=0.0.0.0` (or equivalent) in `envVars`
- [ ] Template definition: port matches the public port from the entrypoint

## Composable Templates

Composable templates add `components` (sub-services) and `topologies` (deployment arrangements) to the basic template system. Use them when a template needs multiple containers or cross-provider routing.

### How to add components and topologies to a template

1. Define your components in the template's `components` array. Each component needs a unique `id` and exactly one source (`primary`, `templateId`, or `inline`).
2. Set `sdlServiceName` on each component — this becomes the Akash SDL service name and is stored on the `Service` DB record for proxy resolution.
3. Mark internal-only components (e.g. databases) with `internalOnly: true` — their ports won't be exposed globally.
4. Use `envLinks` for cross-component env var references (resolved at deploy time).
5. Define `topologies` — each topology lists which components to deploy and on which provider/group.
6. Set `defaultTopology` to the preferred arrangement.

### envLinks placeholder reference

```
{{component.<id>.host}}         → Internal DNS name (same group) or AF proxy URL (cross-group)
{{component.<id>.proxyUrl}}     → Always AF proxy URL: <slug>-app.alternatefutures.ai
{{component.<id>.env.<KEY>}}    → Resolved env var from target component
{{generated.password}}          → Shared 32-char random password
{{generated.secret}}            → Shared base64 random secret
```

**Host resolution rule**: If the source component and target component are in the **same Akash group**, `host` resolves to the target's `sdlServiceName` (internal DNS, zero-latency). Otherwise it resolves to the AF proxy URL. This means the same template definition works for both bundled (single-lease) and split (cross-provider) deployments without changes.

**Bun/Kubernetes warning**: Do **not** assume that because `{{component.<id>.host}}` resolves to an internal service name (for example `postgres`), the application runtime will resolve that hostname the same way as shell tools do. In the Hyperscape incident series (2026-03-15), `getent hosts postgres` and `curl postgres:5432` worked inside the container, but Bun/`pg-pool` still threw `ENOTFOUND`. If the app runs on Bun and needs a peer service in the same lease, prefer the Kubernetes-injected `*_SERVICE_HOST` env var (for example `POSTGRES_SERVICE_HOST`) or rewrite the connection string in `startCommand` before launching Bun.

### Example: converting a simple template to composable

Before (simple template with `customSdl`):

```typescript
export const myApp: Template = {
  id: 'my-app',
  dockerImage: 'myapp:v1',
  // ... resources, ports, envVars ...
  customSdl: '... raw YAML with {{SERVICE_NAME}} and postgres ...',
  companions: [{ templateId: 'postgres', autoLink: true }],
}
```

After (composable):

```typescript
export const myApp: Template = {
  id: 'my-app',
  dockerImage: 'myapp:v1',
  // ... resources, ports, envVars ...

  components: [
    {
      id: 'db',
      name: 'Database',
      templateId: 'postgres',
      internalOnly: true,
      sdlServiceName: 'postgres',
      envDefaults: { POSTGRES_DB: 'myapp' },
    },
    {
      id: 'app',
      name: 'Application',
      primary: true,
      sdlServiceName: 'app',
      envLinks: {
        DATABASE_URL: 'postgresql://postgres:{{generated.password}}@{{component.db.host}}:5432/myapp',
      },
    },
  ],

  topologies: [
    {
      id: 'bundled',
      name: 'Bundled',
      description: 'App + DB in one Akash lease',
      targets: [
        { componentId: 'db', provider: 'akash', group: 'main' },
        { componentId: 'app', provider: 'akash', group: 'main' },
      ],
    },
  ],
  defaultTopology: 'bundled',
}
```

### New files touched when adding a composable template

The composable system adds these files to the standard template chain:

| File | Purpose |
|------|---------|
| `sdl.ts` → `generateCompositeSDL()` | Generates multi-service Akash SDL from `ResolvedComponent[]` |
| `sdl.ts` → `resolveEnvLinks()` | Resolves `envLinks` placeholders based on co-location context |
| `compose.ts` → `generateCompositeCompose()` | Generates single-service Phala compose from a `ResolvedComponent` |
| `resolvers/templates.ts` → `deployCompositeTemplate` | Mutation: creates services, resolves env, dispatches to providers |
| `prisma/schema.prisma` → `sdlServiceName` | Service model field for multi-service proxy resolution |
| `services/proxy/subdomainProxy.ts` | Uses `sdlServiceName` for direct URI lookup in `serviceUrls` |

---

## Reference

### TemplateCategory

| Value        | Description           |
|--------------|-----------------------|
| `GAME_SERVER`| Game servers          |
| `WEB_SERVER` | Web servers / proxies |
| `DATABASE`   | Databases / caches    |
| `AI_ML`      | AI/ML services        |
| `DEVTOOLS`   | Developer tools       |
| `CUSTOM`     | Anything else         |

### serviceType

Must match the `ServiceType` enum used in the Prisma schema:

`SITE` | `FUNCTION` | `VM` | `DATABASE` | `CRON` | `BUCKET`

### Fields that affect deployment

| Field              | Used by                           |
|--------------------|-----------------------------------|
| `dockerImage`      | SDL generator — container image   |
| `envVars`          | SDL generator — env block         |
| `resources`        | SDL generator — compute profile   |
| `ports`            | SDL generator — expose block      |
| `persistentStorage`| SDL generator — volumes + params  |
| `startCommand`     | SDL generator — `args` override (preserves ENTRYPOINT) |
| `pricingUakt`      | SDL generator — pricing section   |
| `serviceType`      | Prisma Service record             |
| `featured`         | Frontend — shows in carousel      |
| `components`       | Composite SDL/compose generators — sub-service definitions |
| `topologies`       | Composite deploy resolver — provider/group routing per component |
| `defaultTopology`  | Frontend — pre-selected topology in config sheet |

### icon field

The `icon` field supports two formats:
- **Emoji**: e.g. `'🐘'` — frontend overrides with react-icons via the switch case in `template-icons.tsx`
- **URL**: e.g. `'https://raw.githubusercontent.com/org/repo/main/icon.png'` — rendered as `<img>` tag automatically, no frontend code changes needed

### Files touched when adding a template

```
Backend (service-cloud-api/src/templates/):
  1. definitions/<id>.ts        ← NEW file
  2. definitions/index.ts       ← add export
  3. registry.ts                ← add to array

Frontend (web-app/components/templates/):
  4. template-icons.tsx          ← add icon case (optional, not needed for URL icons)
```

**Additional files for composable templates** (templates with `components` + `topologies`):

```
Backend (service-cloud-api/src/templates/):
  5. schema.ts                   ← TemplateComponent, DeploymentTopology, TopologyTarget types
  6. sdl.ts                      ← generateCompositeSDL() — multi-service Akash SDL
  7. compose.ts                  ← generateCompositeCompose() — single-service Phala compose

Backend (service-cloud-api/src/):
  8. resolvers/templates.ts      ← deployCompositeTemplate mutation + resolveComponents()

If adding a new component image:
  9. docker/<name>/Dockerfile    ← NEW Docker build for the component
```

No GraphQL schema changes needed — the `Template` type already covers all fields.
No frontend type changes needed — `services/templates/types.ts` already mirrors GraphQL.

### startCommand vs wrapper ENTRYPOINT

**Critical**: The `startCommand` field generates an Akash SDL `args:` block (not `command:`).

In Kubernetes/Akash:
- `command:` overrides the Docker **ENTRYPOINT**
- `args:` overrides the Docker **CMD**

Templates that use wrapper images (e.g. `milady-runtime`, `openclaw-akash`) have a custom ENTRYPOINT that must run at boot (chown + privilege drop). If we used `command:`, the wrapper entrypoint would be bypassed entirely.

**Rules:**
- If your image has a custom ENTRYPOINT (wrapper images), do **not** set `startCommand` — let the Dockerfile CMD handle it.
- If your image has no custom ENTRYPOINT, `startCommand` is safe to use — it becomes `args:` in the SDL, which replaces CMD.

### Existing templates

| ID                    | Category     | Image                          | Featured |
|-----------------------|-------------|--------------------------------|----------|
| `milady-gateway`      | AI_ML       | ghcr.io/alternatefutures/milady:v1 | Yes |
| `openclaw-gateway`    | AI_ML       | ghcr.io/alternatefutures/openclaw-akash:main | Yes |
| `nanobot-gateway`     | AI_ML       | ghcr.io/alternatefutures/nanobot-akash:v1 | Yes |
| `node-ws-gameserver`  | GAME_SERVER | ghcr.io/mavisakalyan/node-ws-gameserver:latest | Yes |
| `bun-ws-gameserver`   | GAME_SERVER | ghcr.io/mavisakalyan/bun-ws-gameserver:latest | Yes |
| `postgres`            | DATABASE    | postgres:16-alpine             | No |
| `redis`               | DATABASE    | redis:7-alpine                 | No |

### Checklist for adding a template

- [ ] Docker image exists and is pullable
- [ ] If wrapper needed: follow the [wrapper image checklist](#wrapper-image-checklist) above
- [ ] Definition file created in `definitions/<id>.ts`
- [ ] Exported from `definitions/index.ts`
- [ ] Added to `registry.ts` array (order = display order)
- [ ] `featured: true` set if it should appear in the carousel
- [ ] Icon case added in `template-icons.tsx` (or URL icon set in definition)
- [ ] No `startCommand` if the image has a custom ENTRYPOINT (wrapper images)
- [ ] Bind address env var set to `0.0.0.0` (not `127.0.0.1`)
- [ ] Image tag is versioned (`:v1`, not `:latest` or `:main`) for Akash
- [ ] If using Bun + internal Akash/K8s service DNS: proved the hostname resolves inside the app runtime itself, not just with shell tools (`getent`, `curl`). If not, use the injected `*_SERVICE_HOST` env var in `startCommand`
- [ ] Tested: template appears in the "Add a service" page
- [ ] Tested: clicking template opens config sheet with correct env vars
- [ ] Tested: deployed service is reachable and UI loads (if applicable)