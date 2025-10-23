import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { BuildResult } from '../storage/types.js';

export interface BuildOptions {
  buildCommand: string;
  installCommand?: string;
  workingDirectory?: string;
  environmentVariables?: Record<string, string>;
}

export class BuildService {
  async build(
    sourceDirectory: string,
    options: BuildOptions,
    onLog?: (log: string) => void
  ): Promise<BuildResult> {
    const logs: string[] = [];
    const log = (message: string) => {
      logs.push(message);
      if (onLog) {
        onLog(message);
      }
    };

    try {
      // Verify source directory exists
      if (!fs.existsSync(sourceDirectory)) {
        return {
          success: false,
          buildPath: '',
          logs,
          error: `Source directory not found: ${sourceDirectory}`,
        };
      }

      // Create a temporary build directory
      const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-build-'));
      log(`Created build directory: ${buildDir}`);

      try {
        // Copy source to build directory
        log('Copying source files...');
        this.copyDirectory(sourceDirectory, buildDir);
        log('Source files copied');

        const workDir = options.workingDirectory
          ? path.join(buildDir, options.workingDirectory)
          : buildDir;

        // Run install command if provided
        if (options.installCommand) {
          log(`Running install command: ${options.installCommand}`);
          const installResult = await this.executeCommand(
            options.installCommand,
            workDir,
            options.environmentVariables,
            log
          );

          if (!installResult.success) {
            return {
              success: false,
              buildPath: buildDir,
              logs,
              error: `Install failed: ${installResult.error}`,
            };
          }
          log('Install completed successfully');
        }

        // Run build command
        log(`Running build command: ${options.buildCommand}`);
        const buildResult = await this.executeCommand(
          options.buildCommand,
          workDir,
          options.environmentVariables,
          log
        );

        if (!buildResult.success) {
          return {
            success: false,
            buildPath: buildDir,
            logs,
            error: `Build failed: ${buildResult.error}`,
          };
        }

        log('Build completed successfully');

        return {
          success: true,
          buildPath: buildDir,
          logs,
        };
      } catch (error) {
        // Clean up on error
        fs.rmSync(buildDir, { recursive: true, force: true });
        throw error;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      log(`Build error: ${errorMessage}`);

      return {
        success: false,
        buildPath: '',
        logs,
        error: errorMessage,
      };
    }
  }

  private async executeCommand(
    command: string,
    workingDirectory: string,
    environmentVariables?: Record<string, string>,
    onLog?: (log: string) => void
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const env = {
        ...process.env,
        ...environmentVariables,
      };

      // Parse command and arguments
      const [cmd, ...args] = command.split(' ');

      const child = spawn(cmd, args, {
        cwd: workingDirectory,
        env,
        shell: true,
      });

      let errorOutput = '';

      child.stdout.on('data', (data) => {
        const output = data.toString();
        if (onLog) {
          onLog(output);
        }
      });

      child.stderr.on('data', (data) => {
        const output = data.toString();
        errorOutput += output;
        if (onLog) {
          onLog(output);
        }
      });

      child.on('error', (error) => {
        resolve({
          success: false,
          error: error.message,
        });
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve({ success: true });
        } else {
          resolve({
            success: false,
            error: errorOutput || `Command exited with code ${code}`,
          });
        }
      });
    });
  }

  private copyDirectory(source: string, destination: string): void {
    if (!fs.existsSync(destination)) {
      fs.mkdirSync(destination, { recursive: true });
    }

    const entries = fs.readdirSync(source, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name);
      const destPath = path.join(destination, entry.name);

      // Skip node_modules and common build artifacts
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === 'dist' ||
        entry.name === 'build'
      ) {
        continue;
      }

      if (entry.isDirectory()) {
        this.copyDirectory(sourcePath, destPath);
      } else {
        fs.copyFileSync(sourcePath, destPath);
      }
    }
  }

  cleanup(buildPath: string): void {
    if (fs.existsSync(buildPath)) {
      fs.rmSync(buildPath, { recursive: true, force: true });
    }
  }
}
