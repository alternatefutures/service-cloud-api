import type { Template } from '../schema.js'

export const gpuInstance: Template = {
  id: 'gpu-instance',
  name: 'GPU Instance',
  description:
    'SSH-ready Linux machine with NVIDIA GPU and CUDA. Install anything — Ollama, vLLM, training frameworks, or your own stack.',
  featured: true,
  category: 'AI_ML',
  tags: ['gpu', 'ssh', 'cuda', 'instance', 'vm', 'linux', 'machine-learning', 'training'],
  icon: '🖥️',
  repoUrl: 'https://github.com/NVIDIA/nvidia-docker',
  dockerImage: 'nvidia/cuda:12.8.1-devel-ubuntu24.04',
  serviceType: 'VM',
  envVars: [
    {
      key: 'SSH_PUBLIC_KEY',
      default: null,
      description: 'Your SSH public key (ssh-rsa/ssh-ed25519). Injected into authorized_keys for passwordless login.',
      required: true,
    },
    {
      key: 'ROOT_PASSWORD',
      default: null,
      description: 'Root password for SSH (fallback if no public key). Leave empty to disable password auth.',
      required: false,
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
    { port: 22, as: 22, global: true },
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
    'apt-get update && apt-get install -y openssh-server curl wget git vim htop tmux',
    'mkdir -p /run/sshd /root/.ssh',
    'if [ -n "$SSH_PUBLIC_KEY" ]; then echo "$SSH_PUBLIC_KEY" > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys; fi',
    'if [ -n "$ROOT_PASSWORD" ]; then echo "root:$ROOT_PASSWORD" | chpasswd && sed -i "s/#PermitRootLogin.*/PermitRootLogin yes/" /etc/ssh/sshd_config; else sed -i "s/#PermitRootLogin.*/PermitRootLogin prohibit-password/" /etc/ssh/sshd_config; fi',
    'sed -i "s/#PasswordAuthentication.*/PasswordAuthentication ${ROOT_PASSWORD:+yes}${ROOT_PASSWORD:-no}/" /etc/ssh/sshd_config',
    'echo "export PATH=/usr/local/cuda/bin:\\$PATH" >> /root/.bashrc',
    'echo "export LD_LIBRARY_PATH=/usr/local/cuda/lib64:\\$LD_LIBRARY_PATH" >> /root/.bashrc',
    '/usr/sbin/sshd -D',
  ].join(' && '),
  pricingUakt: 100000,
}
