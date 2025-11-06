# AlternateFutures GraphQL Backend

GraphQL API server for the AlternateFutures platform - a serverless functions platform that runs on itself.

## 🚀 Quick Start

```bash
# Install dependencies
npm install

# Set up environment
cp .env.example .env

# Set up database
npm run db:push

# Seed test data
npm run db:seed

# Start development server
npm run dev
```

Server runs at: **http://localhost:4000/graphql** 🎉

## 📋 Prerequisites

- Node.js 18+
- PostgreSQL (local or Railway)
- Redis (required for usage buffering)
- pnpm (recommended)

## 🌐 Deploy to Railway

See [../PLATFORM_SETUP.md](../PLATFORM_SETUP.md) for complete deployment guide.

**Quick deploy:**
```bash
railway login
railway init
railway add  # Select PostgreSQL
railway service create alternatefutures-backend
railway service alternatefutures-backend
railway up
```

## 🧪 Test Credentials

After seeding:
- **Token**: `af_local_test_token_12345`
- **Project ID**: `proj-1`

## 📚 API Documentation

GraphQL Playground available at `/graphql`

### Example Mutations

**Create Function:**
```graphql
mutation {
  createFleekFunction(name: "my-api") {
    id
    name
    invokeUrl
  }
}
```

**Deploy Function:**
```graphql
mutation {
  deployFleekFunction(
    functionId: "clxxx"
    cid: "QmXXX"
  ) {
    id
    cid
  }
}
```

## 🛠️ Tech Stack

- **GraphQL Yoga 5** - GraphQL server
- **Prisma** - ORM
- **PostgreSQL** - Database
- **TypeScript** - Language

## 📁 Project Structure

```
src/
├── schema/          # GraphQL schema
├── resolvers/       # Resolvers
├── auth/            # Authentication
├── utils/           # Utilities
└── index.ts         # Server entry

prisma/
└── schema.prisma    # Database schema
```

## 🍽️ Dogfooding

This backend can be deployed as an AlternateFutures Function to run on itself!

See [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) for details.

## 📝 License

MIT
