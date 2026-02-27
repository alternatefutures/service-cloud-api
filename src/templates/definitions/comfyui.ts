import type { Template } from '../schema.js'

export const comfyuiServer: Template = {
  id: 'comfyui',
  name: 'ComfyUI',
  description:
    'Node-based Stable Diffusion UI with GPU acceleration. Build complex image generation pipelines with a visual workflow editor. Supports SD 1.5, SDXL, and Flux.',
  featured: false,
  category: 'AI_ML',
  tags: ['ai', 'stable-diffusion', 'image-generation', 'gpu', 'comfyui', 'generative'],
  icon: '🎨',
  repoUrl: 'https://github.com/comfyanonymous/ComfyUI',
  dockerImage: 'yanwk/comfyui-boot:cu124-slim',
  serviceType: 'VM',
  envVars: [
    {
      key: 'CLI_ARGS',
      default: '--listen 0.0.0.0 --port 8188',
      description: 'ComfyUI command-line arguments',
      required: true,
    },
  ],
  resources: {
    cpu: 4,
    memory: '16Gi',
    storage: '20Gi',
    gpu: { units: 1, vendor: 'nvidia' },
  },
  ports: [
    { port: 8188, as: 80, global: true },
  ],
  persistentStorage: [
    {
      name: 'comfyui-models',
      size: '50Gi',
      mountPath: '/root/ComfyUI/models',
    },
    {
      name: 'comfyui-output',
      size: '10Gi',
      mountPath: '/root/ComfyUI/output',
    },
  ],
  pricingUakt: 80000,
}
