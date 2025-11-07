import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolvers } from './index.js';
import type { Context } from './index.js';

// Mock slug and invoke URL generators
vi.mock('../utils/slug.js', () => ({
  generateSlug: vi.fn((name: string) => name.toLowerCase().replace(/\s+/g, '-')),
}));

vi.mock('../utils/invokeUrl.js', () => ({
  generateInvokeUrl: vi.fn((slug: string) => `https://invoke.example.com/${slug}`),
}));

vi.mock('../utils/routeValidation.js', () => ({
  validateRoutes: vi.fn(),
}));

// Mock createCustomDomain function
const { mockCreateCustomDomain } = vi.hoisted(() => ({
  mockCreateCustomDomain: vi.fn(),
}));

vi.mock('../services/dns/domainService.js', async () => {
  const actual = await vi.importActual('../services/dns/domainService.js');
  return {
    ...actual,
    createCustomDomain: mockCreateCustomDomain,
  };
});

describe('Mutation Resolvers', () => {
  let mockContext: Context;

  beforeEach(() => {
    vi.clearAllMocks();

    mockContext = {
      prisma: {
        project: {
          create: vi.fn(),
        },
        site: {
          create: vi.fn(),
          findUnique: vi.fn(),
        },
        aFFunction: {
          create: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
        aFFunctionDeployment: {
          create: vi.fn(),
        },
        domain: {
          create: vi.fn(),
          findUnique: vi.fn(),
        },
        customer: {
          findUnique: vi.fn(),
        },
        $transaction: vi.fn(async (callback) => {
          // Execute the callback with the mock prisma as the transaction
          return await callback(mockContext.prisma);
        }),
      } as any,
      userId: 'user-123',
      projectId: 'project-123',
    } as any;
  });

  describe('createProject', () => {
    it('should create a new project', async () => {
      const mockProject = {
        id: 'project-123',
        name: 'Test Project',
        slug: 'test-project',
        userId: 'user-123',
      };
      vi.mocked(mockContext.prisma.project.create).mockResolvedValue(mockProject);

      const result = await resolvers.Mutation.createProject(
        {},
        { name: 'Test Project' },
        mockContext
      );

      expect(result).toEqual(mockProject);
      expect(mockContext.prisma.project.create).toHaveBeenCalledWith({
        data: {
          name: 'Test Project',
          slug: 'test-project',
          userId: 'user-123',
        },
      });
    });

    it('should throw error if not authenticated', async () => {
      mockContext.userId = undefined;

      await expect(
        resolvers.Mutation.createProject({}, { name: 'Test Project' }, mockContext)
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('createSite', () => {
    it('should create a new site with context projectId', async () => {
      const mockSite = {
        id: 'site-123',
        name: 'Test Site',
        slug: 'test-site',
        projectId: 'project-123',
      };
      vi.mocked(mockContext.prisma.site.create).mockResolvedValue(mockSite);

      const result = await resolvers.Mutation.createSite(
        {},
        { name: 'Test Site' },
        mockContext
      );

      expect(result).toEqual(mockSite);
      expect(mockContext.prisma.site.create).toHaveBeenCalledWith({
        data: {
          name: 'Test Site',
          slug: 'test-site',
          projectId: 'project-123',
        },
      });
    });

    it('should create a new site with provided projectId', async () => {
      const mockSite = {
        id: 'site-123',
        name: 'Test Site',
        slug: 'test-site',
        projectId: 'custom-project-456',
      };
      vi.mocked(mockContext.prisma.site.create).mockResolvedValue(mockSite);

      const result = await resolvers.Mutation.createSite(
        {},
        { name: 'Test Site', projectId: 'custom-project-456' },
        mockContext
      );

      expect(result).toEqual(mockSite);
      expect(mockContext.prisma.site.create).toHaveBeenCalledWith({
        data: {
          name: 'Test Site',
          slug: 'test-site',
          projectId: 'custom-project-456',
        },
      });
    });

    it('should throw error if project ID is missing', async () => {
      mockContext.projectId = undefined;

      await expect(
        resolvers.Mutation.createSite({}, { name: 'Test Site' }, mockContext)
      ).rejects.toThrow('Project ID required');
    });
  });

  describe('createAFFunction', () => {
    it('should create a new function without routes', async () => {
      const mockFunction = {
        id: 'func-123',
        name: 'Test Function',
        slug: 'test-function',
        invokeUrl: 'https://invoke.example.com/test-function',
        projectId: 'project-123',
        status: 'ACTIVE',
      };
      vi.mocked(mockContext.prisma.aFFunction.create).mockResolvedValue(mockFunction);

      const result = await resolvers.Mutation.createAFFunction(
        {},
        { name: 'Test Function' },
        mockContext
      );

      expect(result).toEqual(mockFunction);
      expect(mockContext.prisma.aFFunction.create).toHaveBeenCalledWith({
        data: {
          name: 'Test Function',
          slug: 'test-function',
          invokeUrl: 'https://invoke.example.com/test-function',
          projectId: 'project-123',
          siteId: undefined,
          routes: undefined,
          status: 'ACTIVE',
        },
      });
    });

    it('should create a new function with routes', async () => {
      const { validateRoutes } = await import('../utils/routeValidation.js');
      const routes = [{ path: '/api/*', destination: 'https://example.com' }];

      const mockFunction = {
        id: 'func-123',
        name: 'Test Function',
        slug: 'test-function',
        invokeUrl: 'https://invoke.example.com/test-function',
        projectId: 'project-123',
        routes,
        status: 'ACTIVE',
      };
      vi.mocked(mockContext.prisma.aFFunction.create).mockResolvedValue(mockFunction);

      const result = await resolvers.Mutation.createAFFunction(
        {},
        { name: 'Test Function', routes },
        mockContext
      );

      expect(validateRoutes).toHaveBeenCalledWith(routes);
      expect(result).toEqual(mockFunction);
    });

    it('should create a new function with siteId', async () => {
      const mockFunction = {
        id: 'func-123',
        name: 'Test Function',
        slug: 'test-function',
        invokeUrl: 'https://invoke.example.com/test-function',
        projectId: 'project-123',
        siteId: 'site-123',
        status: 'ACTIVE',
      };
      vi.mocked(mockContext.prisma.aFFunction.create).mockResolvedValue(mockFunction);

      const result = await resolvers.Mutation.createAFFunction(
        {},
        { name: 'Test Function', siteId: 'site-123' },
        mockContext
      );

      expect(result).toEqual(mockFunction);
      expect(mockContext.prisma.aFFunction.create).toHaveBeenCalledWith({
        data: {
          name: 'Test Function',
          slug: 'test-function',
          invokeUrl: 'https://invoke.example.com/test-function',
          projectId: 'project-123',
          siteId: 'site-123',
          routes: undefined,
          status: 'ACTIVE',
        },
      });
    });

    it('should throw error if project ID is missing', async () => {
      mockContext.projectId = undefined;

      await expect(
        resolvers.Mutation.createAFFunction({}, { name: 'Test Function' }, mockContext)
      ).rejects.toThrow('Project ID required');
    });
  });

  describe('deployAFFunction', () => {
    it('should deploy a function without optional fields', async () => {
      const mockDeployment = {
        id: 'deploy-123',
        cid: 'QmTest123',
        sgx: false,
        afFunctionId: 'func-123',
      };
      vi.mocked(mockContext.prisma.aFFunctionDeployment.create).mockResolvedValue(
        mockDeployment
      );
      vi.mocked(mockContext.prisma.aFFunction.update).mockResolvedValue({} as any);

      const result = await resolvers.Mutation.deployAFFunction(
        {},
        { functionId: 'func-123', cid: 'QmTest123' },
        mockContext
      );

      expect(result).toEqual(mockDeployment);
      expect(mockContext.prisma.aFFunctionDeployment.create).toHaveBeenCalledWith({
        data: {
          cid: 'QmTest123',
          sgx: false,
          blake3Hash: undefined,
          assetsCid: undefined,
          afFunctionId: 'func-123',
        },
      });
      expect(mockContext.prisma.aFFunction.update).toHaveBeenCalledWith({
        where: { id: 'func-123' },
        data: {
          currentDeploymentId: 'deploy-123',
          status: 'ACTIVE',
        },
      });
    });

    it('should deploy a function with all optional fields', async () => {
      const mockDeployment = {
        id: 'deploy-123',
        cid: 'QmTest123',
        sgx: true,
        blake3Hash: 'blake3hash123',
        assetsCid: 'QmAssets456',
        afFunctionId: 'func-123',
      };
      vi.mocked(mockContext.prisma.aFFunctionDeployment.create).mockResolvedValue(
        mockDeployment
      );
      vi.mocked(mockContext.prisma.aFFunction.update).mockResolvedValue({} as any);

      const result = await resolvers.Mutation.deployAFFunction(
        {},
        {
          functionId: 'func-123',
          cid: 'QmTest123',
          sgx: true,
          blake3Hash: 'blake3hash123',
          assetsCid: 'QmAssets456',
        },
        mockContext
      );

      expect(result).toEqual(mockDeployment);
      expect(mockContext.prisma.aFFunctionDeployment.create).toHaveBeenCalledWith({
        data: {
          cid: 'QmTest123',
          sgx: true,
          blake3Hash: 'blake3hash123',
          assetsCid: 'QmAssets456',
          afFunctionId: 'func-123',
        },
      });
    });
  });

  describe('updateAFFunction', () => {
    it('should update function name', async () => {
      const mockFunction = { id: 'func-123', name: 'Updated Name' };
      vi.mocked(mockContext.prisma.aFFunction.update).mockResolvedValue(mockFunction as any);

      const result = await resolvers.Mutation.updateAFFunction(
        {},
        { id: 'func-123', name: 'Updated Name' },
        mockContext
      );

      expect(result).toEqual(mockFunction);
      expect(mockContext.prisma.aFFunction.update).toHaveBeenCalledWith({
        where: { id: 'func-123' },
        data: { name: 'Updated Name' },
      });
    });

    it('should update function slug', async () => {
      const mockFunction = { id: 'func-123', slug: 'new-slug' };
      vi.mocked(mockContext.prisma.aFFunction.update).mockResolvedValue(mockFunction as any);

      const result = await resolvers.Mutation.updateAFFunction(
        {},
        { id: 'func-123', slug: 'new-slug' },
        mockContext
      );

      expect(result).toEqual(mockFunction);
      expect(mockContext.prisma.aFFunction.update).toHaveBeenCalledWith({
        where: { id: 'func-123' },
        data: { slug: 'new-slug' },
      });
    });

    it('should update function routes', async () => {
      const { validateRoutes } = await import('../utils/routeValidation.js');
      const routes = [{ path: '/api/*', destination: 'https://example.com' }];

      const mockFunction = { id: 'func-123', routes };
      vi.mocked(mockContext.prisma.aFFunction.update).mockResolvedValue(mockFunction as any);

      const result = await resolvers.Mutation.updateAFFunction(
        {},
        { id: 'func-123', routes },
        mockContext
      );

      expect(validateRoutes).toHaveBeenCalledWith(routes);
      expect(result).toEqual(mockFunction);
      expect(mockContext.prisma.aFFunction.update).toHaveBeenCalledWith({
        where: { id: 'func-123' },
        data: { routes },
      });
    });

    it('should update function routes to null', async () => {
      const mockFunction = { id: 'func-123', routes: null };
      vi.mocked(mockContext.prisma.aFFunction.update).mockResolvedValue(mockFunction as any);

      const result = await resolvers.Mutation.updateAFFunction(
        {},
        { id: 'func-123', routes: null },
        mockContext
      );

      // validateRoutes is not called when routes is null (based on code logic)
      expect(result).toEqual(mockFunction);
      expect(mockContext.prisma.aFFunction.update).toHaveBeenCalledWith({
        where: { id: 'func-123' },
        data: { routes: null },
      });
    });

    it('should update function status', async () => {
      const mockFunction = { id: 'func-123', status: 'INACTIVE' };
      vi.mocked(mockContext.prisma.aFFunction.update).mockResolvedValue(mockFunction as any);

      const result = await resolvers.Mutation.updateAFFunction(
        {},
        { id: 'func-123', status: 'INACTIVE' },
        mockContext
      );

      expect(result).toEqual(mockFunction);
      expect(mockContext.prisma.aFFunction.update).toHaveBeenCalledWith({
        where: { id: 'func-123' },
        data: { status: 'INACTIVE' },
      });
    });

    it('should update multiple fields at once', async () => {
      const mockFunction = {
        id: 'func-123',
        name: 'New Name',
        slug: 'new-slug',
        status: 'ACTIVE',
      };
      vi.mocked(mockContext.prisma.aFFunction.update).mockResolvedValue(mockFunction as any);

      const result = await resolvers.Mutation.updateAFFunction(
        {},
        { id: 'func-123', name: 'New Name', slug: 'new-slug', status: 'ACTIVE' },
        mockContext
      );

      expect(result).toEqual(mockFunction);
      expect(mockContext.prisma.aFFunction.update).toHaveBeenCalledWith({
        where: { id: 'func-123' },
        data: { name: 'New Name', slug: 'new-slug', status: 'ACTIVE' },
      });
    });
  });

  describe('deleteAFFunction', () => {
    it('should delete a function', async () => {
      vi.mocked(mockContext.prisma.aFFunction.delete).mockResolvedValue({} as any);

      const result = await resolvers.Mutation.deleteAFFunction(
        {},
        { id: 'func-123' },
        mockContext
      );

      expect(result).toBe(true);
      expect(mockContext.prisma.aFFunction.delete).toHaveBeenCalledWith({
        where: { id: 'func-123' },
      });
    });
  });

  describe('createDomain', () => {
    it('should create a new domain', async () => {
      const mockSite = {
        id: 'site-123',
        project: {
          userId: 'user-123',
        },
      };

      const mockDomain = {
        id: 'domain-123',
        hostname: 'example.com',
        siteId: 'site-123',
        verificationStatus: 'PENDING',
      };

      vi.mocked(mockContext.prisma.site.findUnique).mockResolvedValue(mockSite as any);
      vi.mocked(mockContext.prisma.customer.findUnique).mockResolvedValue(null); // No active subscription
      mockCreateCustomDomain.mockResolvedValue(mockDomain);

      const result = await resolvers.Mutation.createDomain(
        {},
        { input: { hostname: 'example.com', siteId: 'site-123' } },
        mockContext
      );

      expect(result).toEqual(mockDomain);
      expect(mockCreateCustomDomain).toHaveBeenCalled();
    });
  });
});
