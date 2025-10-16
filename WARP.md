# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Common commands
- Install deps: `npm install`
- Dev (local):
  - `cp .env.example .env` then set `API_KEY`
  - Ensure local Ollama is running on 11434 (GPU) and 11435 (CPU, optional) or adjust `OLLAMA_GPU_URL`/`OLLAMA_CPU_URL`
  - `npm run dev`
- Build + run (prod): `npm run build && npm start`
- Lint: `npm run lint`
- Docker stack (compose in repo root):
  - NVIDIA GPUs: `docker-compose -f docker-compose.nvidia.yml up -d`
  - CPU-only: `docker-compose -f docker-compose.cpu.yml up -d`
  - Stop: `docker-compose down`
  - Logs: `docker-compose logs -f`
  - NPM wrappers: `npm run start:ollama`, `npm run stop:ollama`, `npm run logs:ollama`, `npm run restart:ollama`
- Tests: none defined (package.json `test` is a placeholder)

## Architecture quick-view
- Runtime: Node.js + TypeScript (ESM, `module` = `NodeNext`). Build to `dist/` via `tsc`.
- Entry: `src/index.ts` (Express app)
  - Auth: simple Bearer token check against `API_KEY`.
  - Model routing: selects target Ollama base URL per requested `model` using `model-routing.json`:
    - CPU list → `OLLAMA_CPU_URL`
    - All others (default) → `OLLAMA_GPU_URL`
  - Native Ollama proxy: `GET/POST /api/*` forwards to the selected Ollama instance, preserves streaming.
  - OpenAI-compatible endpoints:
    - `POST /v1/chat/completions`: transforms OpenAI → Ollama request, streams SSE back as OpenAI chunks.
    - `GET /v1/models`: fetches `/api/tags` from both CPU and GPU, de-duplicates, returns OpenAI list format.
  - Health: `GET /health`.
- Transformers: `src/utils/transformers.ts`
  - `transformOpenAIToOllama`, `transformOllamaToOpenAI`, `transformOllamaStreamToOpenAI`, `transformOllamaModelsToOpenAI`, `generateRequestId`.
- Types: `src/types/{openai,ollama}.ts` define request/response shapes used by transformers and routes.
- Important import note: ESM + `NodeNext` requires file-extensioned relative imports in TS (e.g. `./utils/transformers.js`).

## Docker topology (GPU/CPU + proxy + tunnel + watchdog)
- Two compose variants:
  - `docker-compose.nvidia.yml` (CUDA): `ollama-gpu`, `ollama-cpu`, `proxy`, optional `cloudflared`, `watchdog-gpu`.
  - `docker-compose.cpu.yml` (CPU-only): `ollama`, `proxy`, optional `cloudflared`.
- Watchdog (`watchdog-gpu/`): monitors Ollama GPU logs for fallback conditions and escalates from restart → full recreation.
- Models: `models/` mounted into the GPU container at `/models` to support custom GGUF + Modelfiles.

## Configuration essentials
- Env (`.env`):
  - `API_KEY` (required)
  - `OLLAMA_GPU_URL` (default GPU target), `OLLAMA_CPU_URL` (CPU target for models in routing list)
  - `PORT` (local dev only; containers use internal networking)
- Model routing: copy `model-routing.example.json` → `model-routing.json` and list small models under `cpu`; all others route to GPU by default.
- OpenAI client base URL must include `/v1` (e.g., `http://<host>:3000/v1`); native Ollama uses `/api/*` without `/v1`.
