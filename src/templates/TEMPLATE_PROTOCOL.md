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
  icon: '🌐',                          // Emoji (frontend overrides with react-icons)
  repoUrl: 'https://github.com/...',   // Link shown in config sheet
  dockerImage: 'nginx:alpine',         // Docker Hub or GHCR image
  serviceType: 'VM',                   // Maps to Service.type in DB

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

In `registry.ts`, import and add to the array:

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

If no matching Simple Icon exists, `FaBox` (gray) is used as fallback.

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
| `startCommand`     | SDL generator — command override  |
| `pricingUakt`      | SDL generator — pricing section   |
| `serviceType`      | Prisma Service record             |

### Files touched when adding a template

```
Backend (service-cloud-api/src/templates/):
  1. definitions/<id>.ts        ← NEW file
  2. definitions/index.ts       ← add export
  3. registry.ts                ← add to array

Frontend (web-app/components/templates/):
  4. template-icons.tsx          ← add icon case (optional)
```

No GraphQL schema changes needed — the `Template` type already covers all fields.
No frontend type changes needed — `services/templates/types.ts` already mirrors GraphQL.

### Existing templates

| ID                    | Category     | Image                          |
|-----------------------|-------------|--------------------------------|
| `node-ws-gameserver`  | GAME_SERVER | ghcr.io/mavisakalyan/node-ws-gameserver:latest |
| `bun-ws-gameserver`   | GAME_SERVER | ghcr.io/mavisakalyan/bun-ws-gameserver:latest  |
| `postgres`            | DATABASE    | postgres:16-alpine             |
| `redis`               | DATABASE    | redis:7-alpine                 |
