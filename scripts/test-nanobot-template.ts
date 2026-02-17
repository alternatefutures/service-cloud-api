#!/usr/bin/env npx tsx
/**
 * Test nanobot template — verify template definition, SDL generation, and
 * GraphQL serve path work correctly. Run from service-cloud-api:
 *
 *   npx tsx scripts/test-nanobot-template.ts
 *
 * Requires: Cloud API running on port 1602 (or CLOUD_API_URL)
 */

const CLOUD_API_URL = process.env.CLOUD_API_URL || 'http://localhost:1602';

async function main() {
  console.log('=== Nanobot Template Test ===\n');
  console.log(`Cloud API: ${CLOUD_API_URL}\n`);

  // 1. Test templates GraphQL (no auth)
  console.log('1. Fetching templates from GraphQL...');
  const templatesRes = await fetch(`${CLOUD_API_URL}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query { templates { id name featured dockerImage envVars { key required default } } }`,
    }),
  });
  if (!templatesRes.ok) {
    throw new Error(`GraphQL templates failed: ${templatesRes.status} ${templatesRes.statusText}`);
  }
  const templatesJson = await templatesRes.json();
  if (templatesJson.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(templatesJson.errors)}`);
  }
  const templates: any[] = templatesJson.data?.templates || [];
  const nanobot = templates.find((t: any) => t.id === 'nanobot-gateway');
  if (!nanobot) {
    throw new Error('nanobot-gateway template not found in templates list');
  }
  console.log(`   ✓ nanobot-gateway found`);
  console.log(`   - name: ${nanobot.name}`);
  console.log(`   - featured: ${nanobot.featured}`);
  console.log(`   - dockerImage: ${nanobot.dockerImage}`);
  const required = nanobot.envVars?.filter((v: any) => v.required) || [];
  console.log(`   - required env: ${required.map((v: any) => v.key).join(', ')}`);

  // 2. Test single template fetch
  console.log('\n2. Fetching nanobot template by ID...');
  const templateRes = await fetch(`${CLOUD_API_URL}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query { template(id: "nanobot-gateway") { id name ports { port as } persistentStorage { name size mountPath } } }`,
    }),
  });
  const templateJson = await templateRes.json();
  if (templateJson.errors) throw new Error(`GraphQL errors: ${JSON.stringify(templateJson.errors)}`);
  const tpl = templateJson.data?.template;
  if (!tpl) throw new Error('template(id) returned null');
  console.log(`   ✓ template fetched`);
  console.log(`   - ports: ${JSON.stringify(tpl.ports)}`);
  console.log(`   - persistentStorage: ${JSON.stringify(tpl.persistentStorage)}`);

  // 3. Test SDL generation (in-process)
  console.log('\n3. Testing SDL generation...');
  const { getTemplateById, generateSDLFromTemplate } = await import('../src/templates/index.js');
  const fullTemplate = getTemplateById('nanobot-gateway');
  if (!fullTemplate) throw new Error('getTemplateById returned undefined');
  const sdl = generateSDLFromTemplate(fullTemplate, {
    serviceName: 'nanobot-gateway-test',
    envOverrides: {
      OPENROUTER_API_KEY: 'sk-test-placeholder',
      NANOBOT_DEFAULT_MODEL: 'anthropic/claude-opus-4-5',
      NANOBOT_STATE_DIR: '/home/nanobot/.nanobot',
    },
  });
  if (!sdl.includes('ghcr.io/alternatefutures/nanobot-akash')) {
    throw new Error('SDL missing nanobot image');
  }
  if (!sdl.includes('OPENROUTER_API_KEY=sk-test-placeholder')) {
    throw new Error('SDL missing env override');
  }
  if (!sdl.includes('persistent: true')) {
    throw new Error('SDL missing persistent storage');
  }
  if (!sdl.includes('port: 18790')) {
    throw new Error('SDL missing port 18790');
  }
  console.log(`   ✓ SDL generated (${sdl.split('\n').length} lines)`);
  console.log(`   - image: ghcr.io/alternatefutures/nanobot-akash:v2`);
  console.log(`   - port 18790 exposed`);
  console.log(`   - persistent storage: nanobot-state`);

  console.log('\n=== All tests passed ===\n');
  console.log('Manual deploy test:');
  console.log('  1. Log in to web app (http://localhost:1600)');
  console.log('  2. Create/select org and project');
  console.log('  3. Add Service → select nanobot');
  console.log('  4. Set OPENROUTER_API_KEY (required)');
  console.log('  5. Deploy');
  console.log('');
}

main().catch((e) => {
  console.error('FAILED:', e.message || e);
  process.exit(1);
});
