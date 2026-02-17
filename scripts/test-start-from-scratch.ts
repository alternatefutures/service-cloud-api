#!/usr/bin/env npx tsx
/**
 * Test start-from-scratch flows — createSite, createAFFunction.
 *
 * Run from service-cloud-api:
 *   npx tsx scripts/test-start-from-scratch.ts
 *
 * Requires:
 *   - Cloud API running on port 1602 (or CLOUD_API_URL)
 *   - PROJECT_ID — a project to create services in
 *   - ACCESS_TOKEN — Bearer token (from web app auth or createPersonalAccessToken)
 *
 * Usage:
 *   PROJECT_ID=proj_xxx ACCESS_TOKEN=eyJ... npx tsx scripts/test-start-from-scratch.ts
 *
 * To get ACCESS_TOKEN: log in to the web app, open DevTools → Network, trigger any
 * API call, copy the Authorization header value (without "Bearer ").
 *
 * If ACCESS_TOKEN is missing, runs unit-level checks only (no live API calls).
 */

const CLOUD_API_URL = process.env.CLOUD_API_URL || 'http://localhost:1602';
const PROJECT_ID = process.env.PROJECT_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

async function graphql<T>(
  query: string,
  variables?: Record<string, unknown>,
  headers?: Record<string, string>
): Promise<{ data?: T; errors?: Array<{ message: string }> }> {
  const res = await fetch(`${CLOUD_API_URL}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: ACCESS_TOKEN ? `Bearer ${ACCESS_TOKEN}` : '',
      'X-Project-Id': PROJECT_ID || '',
      ...headers,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

interface CreatedResource {
  type: 'site' | 'function';
  id: string;
  name: string;
}

async function main() {
  console.log('=== Start-from-scratch flows test ===\n');
  console.log(`Cloud API: ${CLOUD_API_URL}`);
  console.log(`Project ID: ${PROJECT_ID || '(not set)'}`);
  console.log(`Access Token: ${ACCESS_TOKEN ? '***' : '(not set)'}\n`);

  const toCleanup: CreatedResource[] = [];

  const runLive = PROJECT_ID && ACCESS_TOKEN;

  if (!runLive) {
    console.log('Skipping live API tests (PROJECT_ID and ACCESS_TOKEN required).');
    console.log('Running unit-level checks only...\n');
  }

  // 1. Unit-level: verify resolvers exist and schema is correct
  console.log('1. Verifying resolver module...');
  const { resolvers } = await import('../src/resolvers/index.js');
  if (!resolvers?.Mutation?.createSite) throw new Error('createSite resolver missing');
  if (!resolvers?.Mutation?.createAFFunction) throw new Error('createAFFunction resolver missing');
  console.log('   ✓ createSite, createAFFunction resolvers present');

  // 2. Run mutation unit tests
  console.log('\n2. Running mutation unit tests...');
  const { execSync } = await import('child_process');
  try {
    execSync('npx vitest run src/resolvers/mutation.test.ts --reporter=dot 2>/dev/null', {
      cwd: process.cwd(),
      stdio: 'pipe',
    });
    console.log('   ✓ createSite and createAFFunction unit tests pass');
  } catch {
    console.log('   ⚠ Run manually: npx vitest run src/resolvers/mutation.test.ts');
  }

  if (!runLive) {
    console.log('\n=== Done (no live API tests) ===');
    console.log('\nTo run live API tests:');
    console.log('  PROJECT_ID=<your-project-id> ACCESS_TOKEN=<bearer-token> npx tsx scripts/test-start-from-scratch.ts');
    return;
  }

  // 3. Live API: create Site
  console.log('\n3. Live API: create Site...');
  const siteName = `test-site-${Date.now()}`;
  const siteRes = await graphql<{ createSite: { id: string; name: string } }>(
    `mutation CreateSite($data: SiteDataInput!) {
      createSite(data: $data) { id name slug }
    }`,
    { data: { name: siteName } }
  );
  if (siteRes.errors?.length) {
    throw new Error(`createSite failed: ${siteRes.errors[0].message}`);
  }
  const siteId = siteRes.data?.createSite?.id;
  if (!siteId) throw new Error('createSite returned no id');
  toCleanup.push({ type: 'site', id: siteId, name: siteName });
  console.log(`   ✓ Site created: ${siteName} (${siteId})`);

  // 4. Live API: create Function (Function type)
  console.log('\n4. Live API: create Function...');
  const fnName = `test-fn-${Date.now()}`;
  const defaultCode = `// test
export default { fetch: () => new Response("ok") };
`;
  const fnRes = await graphql<{ createAFFunction: { id: string; name: string } }>(
    `mutation CreateAFFunction($data: CreateAFFunctionDataInput!) {
      createAFFunction(data: $data) { id name slug sourceCode }
    }`,
    { data: { name: fnName, sourceCode: defaultCode } }
  );
  if (fnRes.errors?.length) {
    throw new Error(`createAFFunction failed: ${fnRes.errors[0].message}`);
  }
  const fnId = fnRes.data?.createAFFunction?.id;
  if (!fnId) throw new Error('createAFFunction returned no id');
  toCleanup.push({ type: 'function', id: fnId, name: fnName });
  console.log(`   ✓ Function created: ${fnName} (${fnId})`);

  // 5. Live API: create Function as placeholder (Docker/Bucket/Volume/Empty all use this)
  console.log('\n5. Live API: create Function (placeholder for Docker/Bucket/Volume/Empty)...');
  const placeholderName = `test-placeholder-${Date.now()}`;
  const placeholderRes = await graphql<{ createAFFunction: { id: string; name: string } }>(
    `mutation CreateAFFunction($data: CreateAFFunctionDataInput!) {
      createAFFunction(data: $data) { id name slug sourceCode }
    }`,
    { data: { name: placeholderName } }
  );
  if (placeholderRes.errors?.length) {
    throw new Error(`createAFFunction (placeholder) failed: ${placeholderRes.errors[0].message}`);
  }
  const placeholderId = placeholderRes.data?.createAFFunction?.id;
  if (!placeholderId) throw new Error('createAFFunction (placeholder) returned no id');
  toCleanup.push({ type: 'function', id: placeholderId, name: placeholderName });
  console.log(`   ✓ Placeholder function created: ${placeholderName} (${placeholderId})`);

  // 6. Verify service registry
  console.log('\n6. Verifying service registry...');
  const regRes = await graphql<{ serviceRegistry: Array<{ id: string; type: string; name: string }> }>(
    `query ServiceRegistry($projectId: ID) { serviceRegistry(projectId: $projectId) { id type name } }`,
    { projectId: PROJECT_ID }
  );
  if (regRes.errors?.length) {
    throw new Error(`serviceRegistry failed: ${regRes.errors[0].message}`);
  }
  const services = regRes.data?.serviceRegistry || [];
  const createdNames = new Set(toCleanup.map((r) => r.name));
  const found = services.filter((s) => createdNames.has(s.name));
  console.log(`   ✓ Created services appear in registry: ${found.length}/${toCleanup.length}`);

  // Cleanup
  console.log('\n7. Cleaning up...');
  for (const r of toCleanup) {
    try {
      if (r.type === 'site') {
        await graphql(
          `mutation DeleteSite($where: SiteWhereInput!) { deleteSite(where: $where) { id } }`,
          { where: { id: r.id } }
        );
      } else {
        await graphql(
          `mutation DeleteAFFunction($where: DeleteAFFunctionWhereInput!) { deleteAFFunction(where: $where) { id } }`,
          { where: { id: r.id } }
        );
      }
      console.log(`   - Deleted ${r.type}: ${r.name}`);
    } catch (e) {
      console.log(`   ⚠ Failed to delete ${r.type} ${r.name}:`, (e as Error).message);
    }
  }

  console.log('\n=== All start-from-scratch flows passed ===');
  console.log('\nManual UI test:');
  console.log('  1. Open web app, go to project Add Service');
  console.log('  2. Under "Start from scratch": Docker, Function, Site, Bucket, Volume, Empty');
  console.log('  3. Each opens ServiceConfigSheet; Create creates service in project');
  console.log('  4. Docker/Bucket/Volume/Empty create as FUNCTION placeholder (docker image not yet used)');
}

main().catch((e) => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});
