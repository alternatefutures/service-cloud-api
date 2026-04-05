import type { Template } from '../schema.js'

export const gpuInstance: Template = {
  id: 'gpu-instance',
  name: 'GPU Instance',
  description:
    'Linux machine with NVIDIA GPU and CUDA. Install anything — Ollama, vLLM, training frameworks, or your own stack. Connect via the web terminal or CLI.',
  featured: true,
  category: 'AI_ML',
  tags: ['gpu', 'cuda', 'instance', 'vm', 'linux', 'machine-learning', 'training'],
  icon: '🖥️',
  repoUrl: 'https://github.com/NVIDIA/nvidia-docker',
  dockerImage: 'nvidia/cuda:12.8.1-devel-ubuntu24.04',
  serviceType: 'VM',
  envVars: [],
  resources: {
    cpu: 8,
    memory: '32Gi',
    storage: '10Gi',
    gpu: { units: 1, vendor: 'nvidia' },
  },
  ports: [
    { port: 8080, as: 80, global: true },
  ],
  persistentStorage: [
    {
      name: 'home',
      size: '100Gi',
      mountPath: '/root/workspace',
    },
  ],
  startCommand: [
    'echo "export PATH=/usr/local/cuda/bin:\\$PATH" >> /root/.bashrc',
    'echo "export LD_LIBRARY_PATH=/usr/local/cuda/lib64:\\$LD_LIBRARY_PATH" >> /root/.bashrc',
    'apt-get update && apt-get install -y curl wget git vim htop tmux',
    'echo "=== GPU instance ready. Use \'af services shell\' or the web terminal to connect. ==="',
    'sleep infinity',
  ].join(' && '),
  pricingUakt: 100000,
}
