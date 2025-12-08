#!/usr/bin/env tsx
/**
 * Infisical Deployment Orchestrator for Akash MCP
 *
 * This script prepares everything needed for deployment and outputs a structured
 * workflow that Claude Code executes via Akash MCP tools.
 *
 * Usage:
 *   tsx scripts/deploy-infisical-mcp.ts [--dry-run] [--output-plan]
 *
 * Options:
 *   --dry-run      Validate SDL without preparing for deployment
 *   --output-plan  Output deployment plan as JSON file
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// ============================================================================
// Types
// ============================================================================

interface Secrets {
  encryptionKey: string;
  jwtSecret: string;
  mongoPassword: string;
}

interface MCPCall {
  step: number;
  name: string;
  tool: string;
  description: string;
  parameters: Record<string, unknown>;
  expectedOutput: string;
  nextStepCondition?: string;
}

interface DeploymentPlan {
  version: string;
  timestamp: string;
  sdlFile: string;
  sdlContent: string;
  deposit: { amount: number; currency: string };
  workflow: MCPCall[];
  postDeployment: string[];
}

// ============================================================================
// Environment & Secrets
// ============================================================================

function loadEnvFile(): void {
  const envPath = join(projectRoot, 'bootstrap.env');
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    envContent.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=').trim();
        if (!process.env[key.trim()]) {
          process.env[key.trim()] = value;
        }
      }
    });
    console.log('✓ Loaded secrets from bootstrap.env');
  }
}

function generateSecret(length: number = 32): string {
  return randomBytes(length).toString('hex');
}

function getSecrets(): Secrets {
  return {
    encryptionKey: process.env.INFISICAL_ENCRYPTION_KEY || generateSecret(16),
    jwtSecret: process.env.INFISICAL_JWT_SECRET || generateSecret(32),
    mongoPassword: process.env.MONGO_INITDB_ROOT_PASSWORD || generateSecret(16),
  };
}

// ============================================================================
// SDL Handling
// ============================================================================

function prepareSDL(secrets: Secrets): string {
  const sdlPath = join(projectRoot, 'deploy-infisical.yaml');

  if (!existsSync(sdlPath)) {
    // Use the final SDL if base doesn't exist
    const finalPath = join(projectRoot, 'deploy-infisical-final.yaml');
    if (existsSync(finalPath)) {
      return readFileSync(finalPath, 'utf-8');
    }
    throw new Error(`SDL file not found: ${sdlPath}`);
  }

  let sdl = readFileSync(sdlPath, 'utf-8');

  // Substitute placeholders if they exist
  sdl = sdl.replace(/PLACEHOLDER_ENCRYPTION_KEY/g, secrets.encryptionKey);
  sdl = sdl.replace(/PLACEHOLDER_JWT_SECRET/g, secrets.jwtSecret);
  sdl = sdl.replace(/PLACEHOLDER_MONGO_PASSWORD/g, secrets.mongoPassword);

  return sdl;
}

function validateSDL(sdl: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  try {
    const parsed = parseYaml(sdl);

    // Check required sections
    if (!parsed.version) errors.push('Missing "version" field');
    if (!parsed.services) errors.push('Missing "services" section');
    if (!parsed.profiles) errors.push('Missing "profiles" section');
    if (!parsed.deployment) errors.push('Missing "deployment" section');

    // Check for placeholder values that weren't substituted
    if (sdl.includes('PLACEHOLDER_')) {
      errors.push('SDL contains unsubstituted PLACEHOLDER_ values');
    }

    // Validate services have required fields
    if (parsed.services) {
      for (const [name, service] of Object.entries(parsed.services as Record<string, any>)) {
        if (!service.image) errors.push(`Service "${name}" missing "image" field`);
        if (!service.expose) errors.push(`Service "${name}" missing "expose" field`);
      }
    }

    // Validate profiles
    if (parsed.profiles?.compute) {
      for (const [name, compute] of Object.entries(parsed.profiles.compute as Record<string, any>)) {
        if (!compute.resources) errors.push(`Compute profile "${name}" missing "resources"`);
      }
    }

  } catch (e) {
    errors.push(`YAML parse error: ${(e as Error).message}`);
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Deployment Plan Generation
// ============================================================================

function generateDeploymentPlan(sdl: string): DeploymentPlan {
  const workflow: MCPCall[] = [
    {
      step: 1,
      name: 'Get Account Address',
      tool: 'mcp__akash__get-akash-account-addr',
      description: 'Retrieve the Akash wallet address for deployment',
      parameters: {},
      expectedOutput: 'Wallet address (akash1...)',
    },
    {
      step: 2,
      name: 'Check Balance',
      tool: 'mcp__akash__get-akash-balances',
      description: 'Verify sufficient AKT balance (need ~5 AKT minimum)',
      parameters: {
        address: '{{WALLET_ADDRESS}}',
      },
      expectedOutput: 'Balance in uakt (1 AKT = 1,000,000 uakt)',
    },
    {
      step: 3,
      name: 'Create Deployment',
      tool: 'mcp__akash__create-deployment',
      description: 'Submit the SDL to create a new deployment on Akash',
      parameters: {
        rawSDL: '{{SDL_CONTENT}}',
        deposit: 5000000,
        currency: 'uakt',
      },
      expectedOutput: 'Deployment created with dseq (deployment sequence number)',
    },
    {
      step: 4,
      name: 'Get Bids',
      tool: 'mcp__akash__get-bids',
      description: 'Wait for and retrieve provider bids. May need to call multiple times.',
      parameters: {
        dseq: '{{DSEQ}}',
        owner: '{{WALLET_ADDRESS}}',
      },
      expectedOutput: 'List of bids with provider addresses and pricing',
      nextStepCondition: 'Wait 10-30 seconds for bids. Call again if empty.',
    },
    {
      step: 5,
      name: 'Create Lease',
      tool: 'mcp__akash__create-lease',
      description: 'Accept a bid and create lease with chosen provider',
      parameters: {
        owner: '{{WALLET_ADDRESS}}',
        dseq: '{{DSEQ}}',
        gseq: 1,
        oseq: 1,
        provider: '{{PROVIDER_ADDRESS}}',
      },
      expectedOutput: 'Lease created successfully',
    },
    {
      step: 6,
      name: 'Send Manifest',
      tool: 'mcp__akash__send-manifest',
      description: 'Send the SDL manifest to the provider to start containers',
      parameters: {
        sdl: '{{SDL_CONTENT}}',
        owner: '{{WALLET_ADDRESS}}',
        dseq: '{{DSEQ}}',
        gseq: 1,
        oseq: 1,
        provider: '{{PROVIDER_ADDRESS}}',
      },
      expectedOutput: 'Manifest sent successfully',
    },
    {
      step: 7,
      name: 'Get Services',
      tool: 'mcp__akash__get-services',
      description: 'Retrieve the URIs for deployed services',
      parameters: {
        owner: '{{WALLET_ADDRESS}}',
        dseq: '{{DSEQ}}',
        gseq: 1,
        oseq: 1,
        provider: '{{PROVIDER_ADDRESS}}',
      },
      expectedOutput: 'Service URIs including the Infisical endpoint',
    },
  ];

  return {
    version: '1.0',
    timestamp: new Date().toISOString(),
    sdlFile: 'deploy-infisical-final.yaml',
    sdlContent: sdl,
    deposit: { amount: 5000000, currency: 'uakt' },
    workflow,
    postDeployment: [
      'Configure DNS: Point secrets.alternatefutures.ai to provider URI',
      'Access Infisical at https://secrets.alternatefutures.ai',
      'Create admin account on first access',
      'Store DSEQ for future reference: {{DSEQ}}',
    ],
  };
}

// ============================================================================
// Output Formatting
// ============================================================================

function printWorkflow(plan: DeploymentPlan): void {
  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│              AKASH MCP DEPLOYMENT WORKFLOW                  │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');

  for (const step of plan.workflow) {
    console.log(`  Step ${step.step}: ${step.name}`);
    console.log(`  ├── Tool: ${step.tool}`);
    console.log(`  ├── ${step.description}`);
    if (step.nextStepCondition) {
      console.log(`  └── Note: ${step.nextStepCondition}`);
    } else {
      console.log(`  └── Expects: ${step.expectedOutput}`);
    }
    console.log('');
  }

  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│                    POST-DEPLOYMENT                          │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');
  plan.postDeployment.forEach((item, i) => {
    console.log(`  ${i + 1}. ${item}`);
  });
  console.log('');
}

function printQuickStart(): void {
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│                      QUICK START                            │');
  console.log('└─────────────────────────────────────────────────────────────┘');
  console.log('');
  console.log('  Tell Claude Code:');
  console.log('');
  console.log('    "Deploy Infisical to Akash using the prepared SDL"');
  console.log('');
  console.log('  Or for step-by-step control:');
  console.log('');
  console.log('    "Execute the Akash deployment workflow step by step"');
  console.log('');
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const outputPlan = args.includes('--output-plan');

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('     Infisical Deployment Orchestrator for Akash MCP');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');

  // Load environment
  loadEnvFile();

  // Get secrets
  const secrets = getSecrets();
  const usingGenerated = !process.env.INFISICAL_ENCRYPTION_KEY;

  if (usingGenerated) {
    console.log('⚠️  No secrets found - generating new ones');
    console.log('');
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│  GENERATED SECRETS (SAVE THESE!)                            │');
    console.log('├─────────────────────────────────────────────────────────────┤');
    console.log(`│  INFISICAL_ENCRYPTION_KEY=${secrets.encryptionKey}`);
    console.log(`│  INFISICAL_JWT_SECRET=${secrets.jwtSecret.substring(0, 32)}...`);
    console.log(`│  MONGO_INITDB_ROOT_PASSWORD=${secrets.mongoPassword}`);
    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');

    // Save to bootstrap.env
    const envContent = `# Infisical Secrets - Generated ${new Date().toISOString()}
INFISICAL_ENCRYPTION_KEY=${secrets.encryptionKey}
INFISICAL_JWT_SECRET=${secrets.jwtSecret}
MONGO_INITDB_ROOT_PASSWORD=${secrets.mongoPassword}
`;
    writeFileSync(join(projectRoot, 'bootstrap.env'), envContent);
    console.log('✓ Saved secrets to bootstrap.env');
  } else {
    console.log('✓ Using existing secrets from bootstrap.env');
  }

  // Prepare SDL
  console.log('');
  console.log('Preparing SDL...');
  const sdl = prepareSDL(secrets);

  // Validate SDL
  console.log('Validating SDL...');
  const validation = validateSDL(sdl);

  if (!validation.valid) {
    console.error('');
    console.error('✗ SDL validation failed:');
    validation.errors.forEach(err => console.error(`  - ${err}`));
    process.exit(1);
  }
  console.log('✓ SDL validation passed');

  if (dryRun) {
    console.log('');
    console.log('Dry run complete. SDL is valid.');
    return;
  }

  // Save prepared SDL
  const outputPath = join(projectRoot, 'deploy-infisical-final.yaml');
  writeFileSync(outputPath, sdl);
  console.log(`✓ Prepared SDL saved to: ${outputPath}`);

  // Generate deployment plan
  const plan = generateDeploymentPlan(sdl);

  // Output plan to file if requested
  if (outputPlan) {
    const planPath = join(projectRoot, 'deployment-plan.json');
    writeFileSync(planPath, JSON.stringify(plan, null, 2));
    console.log(`✓ Deployment plan saved to: ${planPath}`);
  }

  // Print workflow
  printWorkflow(plan);
  printQuickStart();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('                    READY FOR DEPLOYMENT');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
