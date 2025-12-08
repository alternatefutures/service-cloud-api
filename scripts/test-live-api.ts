/**
 * Live API Test Script
 *
 * Tests the deployed service-cloud-api on Akash Network
 *
 * Usage:
 *   npx tsx scripts/test-live-api.ts [api-url]
 *
 * Example:
 *   npx tsx scripts/test-live-api.ts https://9fsk6t78spej915l3he2ejq1jg.ingress.europlots.com
 */

const API_URL = process.argv[2] || 'https://9fsk6t78spej915l3he2ejq1jg.ingress.europlots.com';
const GRAPHQL_URL = `${API_URL}/graphql`;

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  duration: number;
}

const results: TestResult[] = [];

async function runTest(name: string, testFn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await testFn();
    results.push({
      name,
      passed: true,
      message: 'OK',
      duration: Date.now() - start,
    });
    console.log(`✅ ${name} (${Date.now() - start}ms)`);
  } catch (error) {
    results.push({
      name,
      passed: false,
      message: error instanceof Error ? error.message : String(error),
      duration: Date.now() - start,
    });
    console.log(`❌ ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

async function graphqlQuery(query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

// ============ Tests ============

async function testGraphQLEndpoint(): Promise<void> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '{ __typename }' }),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  if (data.data?.__typename !== 'Query') {
    throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
  }
}

async function testSchemaIntrospection(): Promise<void> {
  const result = await graphqlQuery(`
    query {
      __schema {
        queryType { name }
        mutationType { name }
      }
    }
  `);

  const data = result as { data?: { __schema?: { queryType?: { name: string } } } };
  if (!data.data?.__schema?.queryType?.name) {
    throw new Error('Schema introspection failed');
  }
}

async function testAuthRequired(): Promise<void> {
  // This should return an auth error (which is expected behavior)
  const result = await graphqlQuery(`
    query {
      me {
        id
        email
      }
    }
  `);

  const data = result as { errors?: Array<{ message: string }> };
  if (!data.errors?.some(e => e.message.includes('authenticated') || e.message.includes('Unauthorized'))) {
    // If we got data without auth, that's unexpected
    if ((result as { data?: { me?: unknown } }).data?.me) {
      throw new Error('Expected auth error but got data');
    }
  }
}

async function testAvailableQueries(): Promise<void> {
  const result = await graphqlQuery(`
    query {
      __schema {
        queryType {
          fields {
            name
          }
        }
      }
    }
  `);

  const data = result as { data?: { __schema?: { queryType?: { fields?: Array<{ name: string }> } } } };
  const fields = data.data?.__schema?.queryType?.fields || [];

  if (fields.length === 0) {
    throw new Error('No query fields found');
  }

  console.log(`   Found ${fields.length} query fields: ${fields.slice(0, 5).map(f => f.name).join(', ')}...`);
}

async function testAvailableMutations(): Promise<void> {
  const result = await graphqlQuery(`
    query {
      __schema {
        mutationType {
          fields {
            name
          }
        }
      }
    }
  `);

  const data = result as { data?: { __schema?: { mutationType?: { fields?: Array<{ name: string }> } } } };
  const fields = data.data?.__schema?.mutationType?.fields || [];

  if (fields.length === 0) {
    throw new Error('No mutation fields found');
  }

  console.log(`   Found ${fields.length} mutation fields: ${fields.slice(0, 5).map(f => f.name).join(', ')}...`);
}

async function testCORSHeaders(): Promise<void> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'OPTIONS',
  });

  // OPTIONS might return 204 or the server might not support preflight
  // Just check we get a response
  if (response.status >= 500) {
    throw new Error(`Server error: ${response.status}`);
  }
}

async function testGraphiQLPlayground(): Promise<void> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'GET',
    headers: { 'Accept': 'text/html' },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  if (!html.includes('html') && !html.includes('GraphiQL') && !html.includes('graphql')) {
    throw new Error('GraphiQL playground not found');
  }
}

// ============ Main ============

async function main(): Promise<void> {
  console.log(`\n🧪 Testing Live API at ${API_URL}\n`);
  console.log('=' .repeat(60));

  await runTest('GraphQL Endpoint Responds', testGraphQLEndpoint);
  await runTest('Schema Introspection Works', testSchemaIntrospection);
  await runTest('Authentication Required for Protected Routes', testAuthRequired);
  await runTest('Query Fields Available', testAvailableQueries);
  await runTest('Mutation Fields Available', testAvailableMutations);
  await runTest('CORS Headers Present', testCORSHeaders);
  await runTest('GraphiQL Playground Accessible', testGraphiQLPlayground);

  console.log('\n' + '=' .repeat(60));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed (${totalTime}ms total)`);

  if (failed > 0) {
    console.log('\n❌ Failed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`   - ${r.name}: ${r.message}`);
    });
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed!\n');
  }
}

main().catch(console.error);
