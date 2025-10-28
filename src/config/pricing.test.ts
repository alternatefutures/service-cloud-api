import { describe, it, expect } from 'vitest';
import {
  PRICING,
  calculateStorageCost,
  calculateBandwidthCost,
  calculateComputeCost,
  calculateRegistryCost,
  getPricingInfo,
} from './pricing';

describe('Pricing Configuration', () => {
  describe('PRICING constants', () => {
    it('should have correct IPFS storage price', () => {
      expect(PRICING.storage.ipfs).toBe(0.06);
    });

    it('should have correct Filecoin storage price', () => {
      expect(PRICING.storage.filecoin).toBe(0.03);
    });

    it('should have correct Arweave storage price', () => {
      expect(PRICING.storage.arweave).toBe(6.0);
    });

    it('should have correct bandwidth pricing', () => {
      expect(PRICING.bandwidth.free.included).toBe(100);
      expect(PRICING.bandwidth.free.overage).toBe(0.1);
      expect(PRICING.bandwidth.pro.included).toBe(1024);
      expect(PRICING.bandwidth.pro.overage).toBe(0.08);
    });

    it('should have correct compute pricing', () => {
      expect(PRICING.compute.agentRuntime).toBe(0.05);
      expect(PRICING.compute.functionInvocations).toBe(0.2);
      expect(PRICING.compute.gpuProcessing).toBe(0.5);
    });

    it('should have correct registry pricing', () => {
      expect(PRICING.registry.storage).toBe(0.06);
      expect(PRICING.registry.database).toBe(0.1);
      expect(PRICING.registry.compute).toBe(0.02);
    });
  });

  describe('calculateStorageCost', () => {
    it('should calculate IPFS cost correctly', () => {
      // 10 GB for 1 month at $0.06/GB/month = $0.60
      expect(calculateStorageCost('ipfs', 10, 1)).toBe(0.6);
    });

    it('should calculate IPFS cost for multiple months', () => {
      // 5 GB for 3 months at $0.06/GB/month = $0.90
      expect(calculateStorageCost('ipfs', 5, 3)).toBeCloseTo(0.9, 2);
    });

    it('should calculate Filecoin cost correctly', () => {
      // 100 GB for 1 month at $0.03/GB/month = $3.00
      expect(calculateStorageCost('filecoin', 100, 1)).toBe(3.0);
    });

    it('should calculate Arweave one-time cost correctly', () => {
      // 2 GB one-time at $6.00/GB = $12.00
      expect(calculateStorageCost('arweave', 2)).toBe(12.0);
    });

    it('should ignore months parameter for Arweave', () => {
      // Arweave is one-time payment, months should be ignored
      expect(calculateStorageCost('arweave', 2, 12)).toBe(12.0);
    });
  });

  describe('calculateBandwidthCost', () => {
    it('should return 0 for usage within free tier limit', () => {
      expect(calculateBandwidthCost('free', 50)).toBe(0);
      expect(calculateBandwidthCost('free', 100)).toBe(0);
    });

    it('should calculate overage cost for free tier', () => {
      // 150 GB usage, 100 GB included = 50 GB overage at $0.10/GB = $5.00
      expect(calculateBandwidthCost('free', 150)).toBe(5.0);
    });

    it('should return 0 for usage within pro tier limit', () => {
      expect(calculateBandwidthCost('pro', 500)).toBe(0);
      expect(calculateBandwidthCost('pro', 1024)).toBe(0);
    });

    it('should calculate overage cost for pro tier', () => {
      // 1524 GB usage, 1024 GB included = 500 GB overage at $0.08/GB = $40.00
      expect(calculateBandwidthCost('pro', 1524)).toBe(40.0);
    });

    it('should return 0 for enterprise tier (custom pricing)', () => {
      expect(calculateBandwidthCost('enterprise', 10000)).toBe(0);
    });
  });

  describe('calculateComputeCost', () => {
    it('should calculate agent runtime cost', () => {
      // 24 hours at $0.05/hour = $1.20
      expect(calculateComputeCost('agentRuntime', 24)).toBeCloseTo(1.2, 2);
    });

    it('should calculate function invocations cost', () => {
      // 5 million invocations at $0.20/million = $1.00
      expect(calculateComputeCost('functionInvocations', 5)).toBe(1.0);
    });

    it('should calculate GPU processing cost', () => {
      // 10 hours at $0.50/hour = $5.00
      expect(calculateComputeCost('gpuProcessing', 10)).toBe(5.0);
    });
  });

  describe('calculateRegistryCost', () => {
    it('should calculate monthly registry cost', () => {
      // 50 GB storage at $0.06/GB = $3.00
      // 5 GB database at $0.10/GB = $0.50
      // 730 hours compute at $0.02/hour = $14.60
      // Total = $18.10
      expect(calculateRegistryCost(50, 5, 730)).toBeCloseTo(18.1, 2);
    });

    it('should use default 730 hours for 24/7 operation', () => {
      // Default compute hours should be 730 (30.4 days * 24 hours)
      const cost = calculateRegistryCost(10, 1);
      const expectedCompute = 730 * 0.02;
      const expectedStorage = 10 * 0.06;
      const expectedDatabase = 1 * 0.1;
      expect(cost).toBeCloseTo(expectedCompute + expectedStorage + expectedDatabase, 2);
    });

    it('should calculate partial month registry cost', () => {
      // 100 GB storage, 10 GB DB, 168 hours (1 week) compute
      const cost = calculateRegistryCost(100, 10, 168);
      // 100 * 0.06 + 10 * 0.10 + 168 * 0.02 = 6.00 + 1.00 + 3.36 = 10.36
      expect(cost).toBeCloseTo(10.36, 2);
    });
  });

  describe('getPricingInfo', () => {
    it('should return formatted pricing information', () => {
      const info = getPricingInfo();

      expect(info.storage).toHaveLength(3);
      expect(info.storage[0]).toEqual({
        network: 'IPFS',
        type: 'Per GB/month',
        price: 0.06,
      });

      expect(info.bandwidth).toHaveLength(3);
      expect(info.compute).toHaveLength(3);
      expect(info.registry).toHaveLength(3);
    });

    it('should have correct IPFS pricing in info', () => {
      const info = getPricingInfo();
      const ipfsStorage = info.storage.find((s) => s.network === 'IPFS');
      expect(ipfsStorage?.price).toBe(0.06);
    });
  });
});
