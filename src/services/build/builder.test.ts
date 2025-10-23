import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BuildService } from './builder.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('BuildService', () => {
  let buildService: BuildService;
  let tempDir: string;

  beforeEach(() => {
    buildService = new BuildService();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should successfully run a simple build command', async () => {
    // Create a simple package.json
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
        scripts: {
          build: 'echo "Build successful"',
        },
      })
    );

    const result = await buildService.build(tempDir, {
      buildCommand: 'echo "Build successful"',
    });

    expect(result.success).toBe(true);
    expect(result.logs.length).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
  });

  it('should fail for invalid build command', async () => {
    const result = await buildService.build(tempDir, {
      buildCommand: 'this-command-does-not-exist',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should handle missing source directory', async () => {
    const result = await buildService.build('/non-existent-directory', {
      buildCommand: 'echo "test"',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should capture build logs', async () => {
    const logs: string[] = [];

    const result = await buildService.build(
      tempDir,
      {
        buildCommand: 'echo "Test log message"',
      },
      (log) => logs.push(log)
    );

    expect(result.success).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((log) => log.includes('Test log message'))).toBe(true);
  });

  it('should run install command before build', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test-project',
        version: '1.0.0',
      })
    );

    const result = await buildService.build(tempDir, {
      installCommand: 'echo "Installing dependencies"',
      buildCommand: 'echo "Building"',
    });

    expect(result.success).toBe(true);
    expect(result.logs.some((log) => log.includes('Install completed'))).toBe(true);
  });

  it('should cleanup build directory', () => {
    const testBuildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));

    expect(fs.existsSync(testBuildDir)).toBe(true);

    buildService.cleanup(testBuildDir);

    expect(fs.existsSync(testBuildDir)).toBe(false);
  });
});
