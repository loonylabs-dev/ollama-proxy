// src/index.ts
import express, { Request, Response, NextFunction } from 'express';
import fetch from 'node-fetch';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import * as fs from 'fs';
import {
  transformOpenAIToOllama,
  transformOllamaToOpenAI,
  transformOllamaStreamToOpenAI,
  transformOllamaModelsToOpenAI,
  generateRequestId
} from './utils/transformers.js';
import { OpenAIChatRequest } from './types/openai.js';
import { OllamaChatResponse, OllamaChatStreamChunk, OllamaModelsResponse } from './types/ollama.js';

// ESM-specific adjustments
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const apiKey = process.env.API_KEY;
const ollamaGpuUrl = process.env.OLLAMA_GPU_URL || 'http://localhost:11434';
const ollamaCpuUrl = process.env.OLLAMA_CPU_URL || 'http://localhost:11435';

// Load model routing configuration
interface ModelRoutingConfig {
  cpu: string[];
  gpu: string[];
}

let modelRoutingConfig: ModelRoutingConfig = { cpu: [], gpu: ['*'] };

try {
  const configPath = path.join(process.cwd(), 'model-routing.json');
  if (fs.existsSync(configPath)) {
    const configFile = fs.readFileSync(configPath, 'utf-8');
    modelRoutingConfig = JSON.parse(configFile);
    console.log(`Loaded model routing config: ${modelRoutingConfig.cpu.length} CPU models, GPU: ${modelRoutingConfig.gpu.join(', ')}`);
  } else {
    console.warn('model-routing.json not found, using defaults (all models → GPU)');
  }
} catch (error) {
  console.error('Error loading model routing config:', error);
  console.warn('Falling back to defaults (all models → GPU)');
}

// Helper function to determine target Ollama URL based on model name
const getOllamaUrl = (modelName: string): string => {
  // Check if model is in CPU list
  if (modelRoutingConfig.cpu.includes(modelName)) {
    console.log(`Routing model "${modelName}" to CPU instance`);
    return ollamaCpuUrl;
  }

  // Default to GPU (including wildcard "*")
  console.log(`Routing model "${modelName}" to GPU instance (default)`);
  return ollamaGpuUrl;
};

// Auth middleware
const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const auth = req.headers['authorization'];
  if (!apiKey || auth !== `Bearer ${apiKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// ---- Proxy forwarder: forward with model-based routing for /api/* ----
const forwardToOllama = async (req: Request, res: Response) => {
  try {
    const endpoint = req.path.replace('/api', '');

    // For POST requests with body, extract model for routing
    let ollamaUrl = ollamaGpuUrl; // default
    let bodyContent: any = undefined;

    if (req.method === 'POST' && req.body) {
      bodyContent = req.body;

      // Try to extract model from body for routing
      if (bodyContent.model) {
        ollamaUrl = getOllamaUrl(bodyContent.model);
      } else {
        console.log('No model found in request body, defaulting to GPU');
      }
    }

    const targetUrl = `${ollamaUrl}/api${endpoint}`;
    console.log(`Forwarding ${req.method} ${endpoint} to: ${targetUrl}`);

    // Copy headers except host/authorization
    const headers: Record<string, string> = {};
    Object.keys(req.headers).forEach(key => {
      if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'authorization') {
        const value = req.headers[key];
        if (typeof value === 'string') headers[key] = value;
      }
    });
    if (!headers['content-type']) headers['content-type'] = 'application/json';

    // Prepare body for forwarding
    const body = req.method === 'GET' ? undefined : JSON.stringify(bodyContent);

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });

    // set status and copy headers
    res.status(response.status);
    response.headers.forEach((value, key) => {
      // avoid overriding express-controlled headers
      try { res.setHeader(key, value); } catch (e) { /* ignore */ }
    });

    // If there's a body stream, pipe it directly to the express response
    if (response.body) {
      // node-fetch response.body is a Node.js readable stream — pipe to express res
      (response.body as any).pipe(res);
      (response.body as any).on('error', (err: Error) => {
        console.error('Error piping response body:', err);
        try { res.end(); } catch (_) {}
      });
    } else {
      const text = await response.text();
      res.send(text);
    }
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    console.error('Proxy error:', e);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error', details: e.message });
    else res.end();
  }
};

// Parse JSON for all API endpoints to enable model-based routing
app.use('/api', express.json({ limit: '50mb' }));
app.use('/v1', express.json({ limit: '50mb' }));

// Register proxy routes (now with JSON parsing enabled)
app.get('/api/*', authenticate, forwardToOllama);
app.post('/api/*', authenticate, forwardToOllama);

// OpenAI-compatible chat completions endpoint (uses parsed JSON)
app.post('/v1/chat/completions', authenticate, async (req: Request, res: Response) => {
  try {
    const openaiRequest: OpenAIChatRequest = req.body;
    const ollamaUrl = getOllamaUrl(openaiRequest.model);
    const ollamaRequest = transformOpenAIToOllama(openaiRequest);
    const requestId = generateRequestId();

    console.log(`OpenAI Chat request for model: ${openaiRequest.model}, stream: ${openaiRequest.stream}`);

    const targetUrl = `${ollamaUrl}/api/chat`;
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ollamaRequest),
    });

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: { 
          message: `Ollama error: ${response.statusText}`,
          type: 'api_error',
          code: response.status
        }
      });
    }

    if (openaiRequest.stream) {
      // stream via SSE-like event stream (transform chunks)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      let isFirst = true;
      let buffer = '';

      if (response.body) {
        // response.body is a Node stream -> use 'data' events
        response.body.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.trim()) {
              try {
                const ollamaChunk: OllamaChatStreamChunk = JSON.parse(line);
                const openaiChunk = transformOllamaStreamToOpenAI(
                  ollamaChunk, 
                  requestId, 
                  openaiRequest.model,
                  isFirst
                );
                
                res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                isFirst = false;

                if (ollamaChunk.done) {
                  res.write('data: [DONE]\n\n');
                  res.end();
                  return;
                }
              } catch (parseError) {
                console.warn('Failed to parse Ollama streaming chunk:', parseError);
              }
            }
          }
        });

        response.body.on('end', () => {
          if (!res.headersSent) {
            res.write('data: [DONE]\n\n');
          }
          try { res.end(); } catch (_) {}
        });

        response.body.on('error', (error: Error) => {
          console.error('Stream error:', error);
          try { res.end(); } catch (_) {}
        });
      } else {
        // fallback
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } else {
      const ollamaResponse: OllamaChatResponse = await response.json() as OllamaChatResponse;
      const openaiResponse = transformOllamaToOpenAI(ollamaResponse, requestId, openaiRequest.model);
      res.json(openaiResponse);
    }
  } catch (error: unknown) {
    const apiError = error instanceof Error ? error : new Error(String(error));
    console.error('OpenAI Chat API error:', apiError);
    res.status(500).json({ 
      error: {
        message: 'Internal server error',
        type: 'api_error',
        code: 500
      }
    });
  }
});

// Models endpoint - aggregate models from both CPU and GPU instances
app.get('/v1/models', authenticate, async (req: Request, res: Response) => {
  try {
    console.log('OpenAI Models request - fetching from both CPU and GPU instances');

    // Fetch from both instances in parallel
    const [gpuResponse, cpuResponse] = await Promise.allSettled([
      fetch(`${ollamaGpuUrl}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }),
      fetch(`${ollamaCpuUrl}/api/tags`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      })
    ]);

    // Collect models from successful responses
    const allModels: OllamaModelsResponse = { models: [] };

    if (gpuResponse.status === 'fulfilled' && gpuResponse.value.ok) {
      const gpuModels = await gpuResponse.value.json() as OllamaModelsResponse;
      allModels.models.push(...gpuModels.models);
    } else {
      console.warn('Failed to fetch GPU models:', gpuResponse.status === 'fulfilled' ? gpuResponse.value.statusText : gpuResponse.reason);
    }

    if (cpuResponse.status === 'fulfilled' && cpuResponse.value.ok) {
      const cpuModels = await cpuResponse.value.json() as OllamaModelsResponse;
      allModels.models.push(...cpuModels.models);
    } else {
      console.warn('Failed to fetch CPU models:', cpuResponse.status === 'fulfilled' ? cpuResponse.value.statusText : cpuResponse.reason);
    }

    // Remove duplicates (in case same model exists on both instances)
    const uniqueModels = Array.from(
      new Map(allModels.models.map(model => [model.name, model])).values()
    );
    allModels.models = uniqueModels;

    const openaiModels = transformOllamaModelsToOpenAI(allModels);
    res.json(openaiModels);
  } catch (error: unknown) {
    const apiError = error instanceof Error ? error : new Error(String(error));
    console.error('OpenAI Models API error:', apiError);
    res.status(500).json({
      error: {
        message: 'Internal server error',
        type: 'api_error',
        code: 500
      }
    });
  }
});

// Health
app.get('/health', authenticate, (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(port, () => {
  console.log(`Proxy listening on port ${port}`);
  console.log(`GPU instance: ${ollamaGpuUrl}`);
  console.log(`CPU instance: ${ollamaCpuUrl}`);
  console.log(`Routing: ${modelRoutingConfig.cpu.length} model(s) → CPU, others → GPU (default)`);
});
