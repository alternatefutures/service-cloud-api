# GraphQL Code Generation

This project uses GraphQL Code Generator to automatically generate TypeScript types from the GraphQL schema.

## What Gets Generated

1. **Backend Resolver Types** (`src/generated/graphql.ts`)
   - TypeScript types for all GraphQL types and resolvers
   - Type-safe resolver function signatures
   - Mapped to Prisma models

2. **GraphQL Schema File** (`src/generated/schema.graphql`)
   - Schema introspection file
   - Used for tools and documentation

3. **SDK Client Types** (`../cloud-sdk/src/generated/graphql-types.ts`)
   - TypeScript types for the SDK client
   - Ensures type safety between backend and SDK

## Usage

### Generate Types

Run type generation after changing the GraphQL schema:

```bash
npm run generate:types
```

### Watch Mode

Automatically regenerate types when schema changes:

```bash
npm run generate:types:watch
```

### When to Generate

Generate types whenever you:

- Add or modify GraphQL types in `src/schema/typeDefs.ts`
- Add or modify resolvers
- Change Prisma schema (after running `npx prisma generate`)

## Configuration

The code generation is configured in `codegen.ts`:

- **Schema source**: `src/schema/typeDefs.ts`
- **Context type**: Custom GraphQL context with auth info
- **Mappers**: Maps GraphQL types to Prisma models for type safety

## Integration with Development

The generated types are automatically used by:

1. **Resolvers**: Type-safe resolver implementations
2. **Tests**: Ensures tests use correct types
3. **SDK**: Keeps client types in sync with backend

## Example

After running codegen, your resolvers become fully type-safe:

```typescript
import { Resolvers } from './generated/graphql'

export const domainResolvers: Resolvers = {
  Mutation: {
    createDomain: async (_parent, args, context) => {
      // args and context are fully typed!
      const domain = await context.prisma.domain.create({
        data: args.input,
      })
      return domain
    },
  },
}
```

## Troubleshooting

**Types not updating?**

- Run `npm run generate:types` manually
- Check for TypeScript errors in schema definition
- Ensure Prisma types are up to date (`npx prisma generate`)

**SDK types out of sync?**

- Ensure you've run codegen in the backend
- Generated file is at `../cloud-sdk/src/generated/graphql-types.ts`
- Rebuild SDK after generation
