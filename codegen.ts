import type { CodegenConfig } from '@graphql-codegen/cli'

const config: CodegenConfig = {
  overwrite: true,
  schema: './src/schema/typeDefs.ts',
  generates: {
    // Generate TypeScript types for resolvers
    'src/generated/graphql.ts': {
      plugins: ['typescript', 'typescript-resolvers'],
      config: {
        useIndexSignature: true,
        contextType: '../resolvers/types#GraphQLContext',
        mappers: {
          Site: '@prisma/client#Site',
          Domain: '@prisma/client#Domain',
          Deployment: '@prisma/client#Deployment',
          Project: '@prisma/client#Project',
          User: '@prisma/client#User',
          Invoice: '@prisma/client#Invoice',
          UsageRecord: '@prisma/client#UsageRecord',
          Pin: '@prisma/client#Pin',
          IPNSRecord: '@prisma/client#IPNSRecord',
        },
      },
    },
    // Generate schema introspection for SDK
    'src/generated/schema.graphql': {
      plugins: ['schema-ast'],
    },
    // Generate TypeScript types for client SDK
    '../cloud-sdk/src/generated/graphql-types.ts': {
      plugins: ['typescript', 'typescript-operations'],
      config: {
        skipTypename: false,
        enumsAsTypes: true,
      },
    },
  },
}

export default config
