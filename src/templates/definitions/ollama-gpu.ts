import type { Template } from '../schema.js'

export const ollamaGpu: Template = {
  id: 'ollama-gpu',
  name: 'Ollama GPU',
  description:
    'Run any open LLM (Llama 70B, Qwen 72B, Mistral, etc.) on GPU. OpenAI-compatible API included. Pull models on demand.',
  featured: true,
  category: 'AI_ML',
  tags: ['ai', 'llm', 'inference', 'gpu', 'ollama', 'openai'],
  icon: '🦙',
  repoUrl: 'https://github.com/ollama/ollama',
  dockerImage: 'ollama/ollama:0.6.2',
  serviceType: 'VM',
  envVars: [
    {
      key: 'OLLAMA_HOST',
      default: '0.0.0.0',
      description: 'Listen address (0.0.0.0 for all interfaces)',
      required: true,
    },
    {
      key: 'OLLAMA_MODELS',
      default: '/data/models',
      description: 'Directory for downloaded model weights (persistent)',
      required: true,
    },
  ],
  resources: {
    cpu: 4,
    memory: '16Gi',
    storage: '10Gi',
    gpu: { units: 1, vendor: 'nvidia' },
  },
  ports: [
    { port: 11434, as: 80, global: true },
  ],
  persistentStorage: [
    {
      name: 'ollama-models',
      size: '50Gi',
      mountPath: '/data/models',
    },
  ],
  pricingUakt: 100000,
}
