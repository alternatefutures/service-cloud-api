-- Per-model VRAM and interface for compute providers, populated from the
-- Akash console API's gpuModels[].ram / .interface fields. Stored as JSON
-- maps keyed by lowercase model name (e.g. {"h100":"80Gi","a100":"80Gi"}).
--
-- These columns enable surfacing VRAM in the GPU selection dropdown and
-- the deployed-resources overview card without re-deriving it from the
-- raw chain-attribute blob on every read.

ALTER TABLE "compute_provider" ADD COLUMN "gpu_ram" JSONB;
ALTER TABLE "compute_provider" ADD COLUMN "gpu_interface" JSONB;
