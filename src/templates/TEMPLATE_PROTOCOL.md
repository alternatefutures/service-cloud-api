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

No GraphQL schema changes needed — the `Template` type already covers all fields.
No frontend type changes needed — `services/templates/types.ts` already mirrors GraphQL.

### startCommand vs wrapper ENTRYPOINT

**Critical**: The `startCommand` field generates an Akash SDL `args:` block (not `command:`).

In Kubernetes/Akash:
- `command:` overrides the Docker **ENTRYPOINT**
- `args:` overrides the Docker **CMD**

Templates that use wrapper images (e.g. `milaidy-akash`, `openclaw-akash`) have a custom ENTRYPOINT that must run at boot (chown + privilege drop). If we used `command:`, the wrapper entrypoint would be bypassed entirely.

**Rules:**
- If your image has a custom ENTRYPOINT (wrapper images), do **not** set `startCommand` — let the Dockerfile CMD handle it.
- If your image has no custom ENTRYPOINT, `startCommand` is safe to use — it becomes `args:` in the SDL, which replaces CMD.

### Existing templates

| ID                    | Category     | Image                          | Featured |
|-----------------------|-------------|--------------------------------|----------|
| `milaidy-gateway`     | AI_ML       | ghcr.io/alternatefutures/milaidy-akash:main | Yes |
| `openclaw-gateway`    | AI_ML       | ghcr.io/alternatefutures/openclaw-akash:main | Yes |
| `node-ws-gameserver`  | GAME_SERVER | ghcr.io/mavisakalyan/node-ws-gameserver:latest | Yes |
| `bun-ws-gameserver`   | GAME_SERVER | ghcr.io/mavisakalyan/bun-ws-gameserver:latest | Yes |
| `postgres`            | DATABASE    | postgres:16-alpine             | No |
| `redis`               | DATABASE    | redis:7-alpine                 | No |

### Checklist for adding a template

- [ ] Docker image exists and is pullable
- [ ] Definition file created in `definitions/<id>.ts`
- [ ] Exported from `definitions/index.ts`
- [ ] Added to `registry.ts` array (order = display order)
- [ ] `featured: true` set if it should appear in the carousel
- [ ] Icon case added in `template-icons.tsx` (or URL icon set in definition)
- [ ] Tested: template appears in the "Add a service" page
- [ ] Tested: clicking template opens config sheet with correct env vars
