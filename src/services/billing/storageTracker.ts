/**
 * Storage Tracker Service
 *
 * Tracks IPFS pin/unpin events for billing purposes
 * Since IPFS content is immutable (CID is hash of content),
 * we only track pin/unpin events, not size changes
 */

import type { PrismaClient } from '@prisma/client'
import { UsageService } from './usageService.js'

export class StorageTracker {
  private usageService: UsageService

  constructor(private prisma: PrismaClient) {
    this.usageService = new UsageService(prisma)
  }

  /**
   * Track when content is pinned to IPFS
   */
  async trackPinEvent(
    userId: string,
    cid: string,
    sizeBytes: number,
    filename?: string,
    mimeType?: string,
    metadata?: any
  ): Promise<string> {
    // Check if already pinned (avoid duplicates)
    const existing = await this.prisma.pinnedContent.findFirst({
      where: {
        userId,
        cid,
        unpinnedAt: null,
      },
    })

    if (existing) {
      // Already pinned, don't double-count
      return existing.id
    }

    // Record the pin
    const pin = await this.prisma.pinnedContent.create({
      data: {
        userId,
        cid,
        sizeBytes: BigInt(sizeBytes),
        filename,
        mimeType,
        metadata,
      },
    })

    // Record usage for billing
    await this.usageService.recordUsage(
      userId,
      'STORAGE',
      sizeBytes / 1024 ** 3, // Convert to GB
      'GB',
      'IPFS',
      cid,
      {
        action: 'pin',
        cid,
        filename,
        sizeBytes,
      }
    )

    return pin.id
  }

  /**
   * Track when content is unpinned from IPFS
   */
  async trackUnpinEvent(userId: string, cid: string): Promise<boolean> {
    // Find the active pin
    const pin = await this.prisma.pinnedContent.findFirst({
      where: {
        userId,
        cid,
        unpinnedAt: null,
      },
    })

    if (!pin) {
      // Not currently pinned, nothing to do
      return false
    }

    // Mark as unpinned
    await this.prisma.pinnedContent.update({
      where: { id: pin.id },
      data: { unpinnedAt: new Date() },
    })

    // Record negative usage to deduct from billing
    await this.usageService.recordUsage(
      userId,
      'STORAGE',
      -Number(pin.sizeBytes) / 1024 ** 3, // Negative to deduct
      'GB',
      'IPFS',
      cid,
      {
        action: 'unpin',
        cid,
        sizeBytes: Number(pin.sizeBytes),
      }
    )

    return true
  }

  /**
   * Get currently pinned storage for a user (in bytes)
   */
  async getCurrentStorage(userId: string): Promise<bigint> {
    const result = await this.prisma.pinnedContent.aggregate({
      where: {
        userId,
        unpinnedAt: null, // Only currently pinned
      },
      _sum: {
        sizeBytes: true,
      },
    })

    return result._sum.sizeBytes || BigInt(0)
  }

  /**
   * Get count of currently pinned items
   */
  async getPinCount(userId: string): Promise<number> {
    return this.prisma.pinnedContent.count({
      where: {
        userId,
        unpinnedAt: null,
      },
    })
  }

  /**
   * Get list of currently pinned content
   */
  async getActivePins(userId: string, limit = 100) {
    return this.prisma.pinnedContent.findMany({
      where: {
        userId,
        unpinnedAt: null,
      },
      orderBy: {
        pinnedAt: 'desc',
      },
      take: limit,
    })
  }

  /**
   * Calculate average storage for a billing period (GB-days)
   * This is useful for accurate billing based on actual storage duration
   */
  async calculateStorageForPeriod(
    userId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<number> {
    // Get all pins that existed during this period
    const pins = await this.prisma.pinnedContent.findMany({
      where: {
        userId,
        pinnedAt: { lte: periodEnd },
        OR: [
          { unpinnedAt: null }, // Still pinned
          { unpinnedAt: { gte: periodStart } }, // Unpinned during period
        ],
      },
    })

    // Calculate total GB-hours
    let totalGBHours = 0
    const periodHours =
      (periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60)

    for (const pin of pins) {
      // Determine actual start and end times within the period
      const start = pin.pinnedAt > periodStart ? pin.pinnedAt : periodStart
      const end =
        pin.unpinnedAt && pin.unpinnedAt < periodEnd
          ? pin.unpinnedAt
          : periodEnd

      // Calculate hours this pin was active
      const hoursStored = (end.getTime() - start.getTime()) / (1000 * 60 * 60)
      const sizeGB = Number(pin.sizeBytes) / 1024 ** 3

      totalGBHours += sizeGB * hoursStored
    }

    // Return average GB stored during period
    return totalGBHours / periodHours
  }

  /**
   * Create daily snapshot of storage usage
   * Should be called by scheduler once per day
   */
  async createDailySnapshot(userId: string, date?: Date): Promise<string> {
    const snapshotDate = date || new Date()
    // Set to midnight
    snapshotDate.setHours(0, 0, 0, 0)

    const totalBytes = await this.getCurrentStorage(userId)
    const pinCount = await this.getPinCount(userId)

    const snapshot = await this.prisma.storageSnapshot.upsert({
      where: {
        userId_date: {
          userId,
          date: snapshotDate,
        },
      },
      create: {
        userId,
        date: snapshotDate,
        totalBytes,
        pinCount,
      },
      update: {
        totalBytes,
        pinCount,
      },
    })

    return snapshot.id
  }

  /**
   * Get storage snapshots for a period (for analytics)
   */
  async getSnapshots(userId: string, startDate: Date, endDate: Date) {
    return this.prisma.storageSnapshot.findMany({
      where: {
        userId,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: {
        date: 'asc',
      },
    })
  }
}
