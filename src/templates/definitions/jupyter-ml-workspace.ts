import type { Template } from '../schema.js'

export const jupyterMlWorkspace: Template = {
  id: 'jupyter-ml-workspace',
  name: 'Jupyter ML Workspace',
  description:
    'GPU-powered Jupyter Lab with PyTorch and CUDA pre-installed. Fine-tune models, run experiments, and train on cloud GPU.',
  featured: true,
  category: 'AI_ML',
  tags: ['ai', 'ml', 'jupyter', 'pytorch', 'gpu', 'training', 'fine-tuning'],
  icon: '📓',
  repoUrl: 'https://github.com/jupyter/docker-stacks',
  dockerImage: 'quay.io/jupyter/pytorch-notebook:cuda12-pytorch-2.5.1',
  serviceType: 'VM',
  envVars: [
    {
      key: 'JUPYTER_TOKEN',
      default: null,
      description: 'Access token for Jupyter Lab (acts as password)',
      required: true,
      secret: true,
    },
  ],
  resources: {
    cpu: 8,
    memory: '32Gi',
    storage: '10Gi',
    gpu: { units: 1, vendor: 'nvidia' },
  },
  ports: [
    { port: 8888, as: 80, global: true },
  ],
  persistentStorage: [
    {
      name: 'jupyter-work',
      size: '100Gi',
      mountPath: '/home/jovyan/work',
    },
  ],
  pricingUakt: 100000,
  startCommand: 'start-notebook.py --NotebookApp.token=$JUPYTER_TOKEN --NotebookApp.allow_origin=* --NotebookApp.base_url=/',
}
