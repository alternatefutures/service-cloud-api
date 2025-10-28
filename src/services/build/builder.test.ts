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

  it('should fail when install command fails', async () => {
    const result = await buildService.build(tempDir, {
      installCommand: 'exit 1',
      buildCommand: 'echo "Building"',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Install failed');
  });

  it('should cleanup build directory', () => {
    const testBuildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));

    expect(fs.existsSync(testBuildDir)).toBe(true);

    buildService.cleanup(testBuildDir);

    expect(fs.existsSync(testBuildDir)).toBe(false);
  });

  it('should handle cleanup when directory does not exist', () => {
    const nonExistentDir = path.join(os.tmpdir(), 'non-existent-' + Date.now());

    expect(fs.existsSync(nonExistentDir)).toBe(false);

    // Should not throw error
    expect(() => buildService.cleanup(nonExistentDir)).not.toThrow();
  });

  it('should copy directories with subdirectories', async () => {
    // Create a source directory with nested structure
    const srcDir = path.join(tempDir, 'src');
    const nestedDir = path.join(srcDir, 'nested');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });

    fs.writeFileSync(path.join(srcDir, 'file1.txt'), 'content1');
    fs.writeFileSync(path.join(nestedDir, 'file2.txt'), 'content2');

    const result = await buildService.build(tempDir, {
      buildCommand: 'echo "test"',
    });

    expect(result.success).toBe(true);
    expect(result.buildPath).toBeDefined();
  });

  it('should skip node_modules when copying', async () => {
    // Create source with node_modules
    const nodeModulesDir = path.join(tempDir, 'node_modules');
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.writeFileSync(path.join(nodeModulesDir, 'package.txt'), 'should-be-skipped');

    const srcFile = path.join(tempDir, 'app.js');
    fs.writeFileSync(srcFile, 'console.log("test")');

    const result = await buildService.build(tempDir, {
      buildCommand: 'echo "test"',
    });

    expect(result.success).toBe(true);
    expect(result.buildPath).toBeDefined();

    // node_modules should not be in the build directory
    if (result.buildPath) {
      const copiedNodeModules = path.join(result.buildPath, 'node_modules');
      expect(fs.existsSync(copiedNodeModules)).toBe(false);
    }
  });

  it('should skip .git directory when copying', async () => {
    // Create source with .git directory
    const gitDir = path.join(tempDir, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, 'config'), 'should-be-skipped');

    const srcFile = path.join(tempDir, 'app.js');
    fs.writeFileSync(srcFile, 'console.log("test")');

    const result = await buildService.build(tempDir, {
      buildCommand: 'echo "test"',
    });

    expect(result.success).toBe(true);
    expect(result.buildPath).toBeDefined();

    // .git should not be in the build directory
    if (result.buildPath) {
      const copiedGit = path.join(result.buildPath, '.git');
      expect(fs.existsSync(copiedGit)).toBe(false);
    }
  });

  it('should handle errors during directory copy', async () => {
    // Create a directory structure that will cause an error
    // For instance, trying to read a file without permissions (platform dependent)
    // Or we can just test with an invalid source
    const result = await buildService.build('/root/totally-inaccessible-path-12345', {
      buildCommand: 'echo "test"',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.buildPath).toBe('');
  });

  it('should handle spawn errors when command cannot be found', async () => {
    // This test should trigger the 'error' event on the child process
    // by trying to execute a command that doesn't exist in a way that causes spawn to fail

    const result = await buildService.build(tempDir, {
      buildCommand: '\0invalid\0command\0', // Null bytes should cause spawn to fail
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should handle non-Error exceptions', async () => {
    // This is harder to test naturally, but we can try to cause a non-Error to be thrown
    // For instance, source directory issues
    const result = await buildService.build('', {
      buildCommand: 'echo "test"',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});
