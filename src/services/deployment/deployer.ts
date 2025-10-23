import type { PrismaClient } from '@prisma/client';
import { StorageServiceFactory, type StorageType } from '../storage/factory.js';
import { BuildService, type BuildOptions } from '../build/builder.js';
import { deploymentEvents } from '../events/index.js';

export interface DeploymentOptions {
  siteId: string;
  sourceDirectory: string;
  storageType: StorageType;
  buildOptions?: BuildOptions;
  outputDirectory?: string;
}

export interface DeploymentCallbacks {
  onStatusChange?: (status: string) => void;
  onLog?: (log: string) => void;
}

export class DeploymentService {
  constructor(private prisma: PrismaClient) {}

  async deploy(
    options: DeploymentOptions,
    callbacks?: DeploymentCallbacks
  ): Promise<{ deploymentId: string; cid: string; url: string }> {
    const { siteId, sourceDirectory, storageType, buildOptions, outputDirectory } = options;
    const { onStatusChange, onLog } = callbacks || {};

    // Create deployment record with PENDING status
    const deployment = await this.prisma.deployment.create({
      data: {
        siteId,
        cid: '', // Will be updated after upload
        status: 'PENDING',
        storageType,
      },
    });

    const deploymentId = deployment.id;

    // Helper to emit logs and call callback
    const emitLog = (message: string, level: 'info' | 'error' | 'warn' = 'info') => {
      deploymentEvents.emitLog({
        deploymentId,
        timestamp: new Date(),
        message,
        level,
      });
      onLog?.(message);
    };

    // Helper to emit status and call callback
    const emitStatus = (status: string) => {
      deploymentEvents.emitStatus({
        deploymentId,
        status,
        timestamp: new Date(),
      });
      onStatusChange?.(status);
    };

    try {
      let uploadDirectory = sourceDirectory;

      // If build options provided, run build first
      if (buildOptions) {
        emitStatus('BUILDING');
        await this.prisma.deployment.update({
          where: { id: deploymentId },
          data: { status: 'BUILDING' },
        });

        emitLog('Starting build process...');
        const buildService = new BuildService();
        const buildResult = await buildService.build(
          sourceDirectory,
          buildOptions,
          emitLog
        );

        if (!buildResult.success) {
          await this.prisma.deployment.update({
            where: { id: deploymentId },
            data: { status: 'FAILED' },
          });

          emitStatus('FAILED');
          emitLog(`Build failed: ${buildResult.error}`, 'error');

          // Clean up build directory
          if (buildResult.buildPath) {
            buildService.cleanup(buildResult.buildPath);
          }

          throw new Error(`Build failed: ${buildResult.error}`);
        }

        emitLog('Build completed successfully');

        // Use the build output directory
        uploadDirectory = outputDirectory
          ? `${buildResult.buildPath}/${outputDirectory}`
          : buildResult.buildPath;
      }

      // Upload to storage
      emitStatus('UPLOADING');
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: 'UPLOADING' },
      });

      emitLog(`Uploading to ${storageType}...`);
      const storageService = StorageServiceFactory.create(storageType);
      const uploadResult = await storageService.uploadDirectory(uploadDirectory);

      emitLog(`Upload completed: ${uploadResult.url}`);

      // Update deployment with CID and success status
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: {
          cid: uploadResult.cid,
          status: 'SUCCESS',
        },
      });

      // Create pin record
      await this.prisma.pin.create({
        data: {
          cid: uploadResult.cid,
          name: `Site ${siteId}`,
          size: uploadResult.size,
          deploymentId,
        },
      });

      emitStatus('SUCCESS');
      emitLog('Deployment completed successfully');

      // Clean up build directory if we created one
      if (buildOptions) {
        const buildService = new BuildService();
        buildService.cleanup(uploadDirectory.split('/').slice(0, -1).join('/'));
      }

      return {
        deploymentId,
        cid: uploadResult.cid,
        url: uploadResult.url,
      };
    } catch (error) {
      // Mark deployment as failed
      await this.prisma.deployment.update({
        where: { id: deploymentId },
        data: { status: 'FAILED' },
      });

      emitStatus('FAILED');
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      emitLog(`Deployment failed: ${errorMessage}`, 'error');

      throw error;
    }
  }
}
