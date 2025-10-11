// src/index.ts
import express, { Request, Response, NextFunction } from 'express';
import fetch from 'node-fetch';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
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

// Helper function to determine target Ollama URL based on compute type header
const getOllamaUrl = (req: Request): string => {
  const computeType = req.headers['x-compute-type'] as string | undefined;

  if (computeType === 'cpu') {
    console.log('Routing to CPU instance');
    return ollamaCpuUrl;
  }

  // Default to GPU
  console.log('Routing to GPU instance (default)');
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

// ---- Proxy forwarder: forward raw stream for /api/* (no body-parser here) ----
const forwardToOllama = async (req: Request, res: Response) => {
  try {
    const ollamaUrl = getOllamaUrl(req);
    const endpoint = req.path.replace('/api', '');
    const targetUrl = `${ollamaUrl}/api${endpoint}`;

    console.log(`Forwarding request to: ${targetUrl} (method=${req.method})`);

    // Copy headers except host/authorization (we keep client's headers like content-type)
    const headers: Record<string, string> = {};
    Object.keys(req.headers).forEach(key => {
      if (key.toLowerCase() !== 'host' && key.toLowerCase() !== 'authorization') {
        const value = req.headers[key];
        if (typeof value === 'string') headers[key] = value;
      }
    });
    if (!headers['content-type']) headers['content-type'] = 'application/json';

    // For GET no body, otherwise forward the raw incoming request stream
    const body = req.method === 'GET' ? undefined : (req as any);

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
      // optional: keepalive/timeouts could be added here if desired
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

// Register proxy routes (no JSON parser before these)
app.get('/api/*', authenticate, forwardToOllama);
app.post('/api/*', authenticate, forwardToOllama);

// ---- Only parse JSON for /v1 endpoints that actually need it ----
app.use('/v1', express.json({ limit: '50mb' }));

// OpenAI-compatible chat completions endpoint (uses parsed JSON)
app.post('/v1/chat/completions', authenticate, async (req: Request, res: Response) => {
  try {
    const ollamaUrl = getOllamaUrl(req);
    const openaiRequest: OpenAIChatRequest = req.body;
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

// Models endpoint (parsing not required)
app.get('/v1/models', authenticate, async (req: Request, res: Response) => {
  try {
    const ollamaUrl = getOllamaUrl(req);
    console.log('OpenAI Models request');

    const targetUrl = `${ollamaUrl}/api/tags`;
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
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

    const ollamaModels: OllamaModelsResponse = await response.json() as OllamaModelsResponse;
    const openaiModels = transformOllamaModelsToOpenAI(ollamaModels);
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
  console.log(`GPU instance: ${ollamaGpuUrl} (default)`);
  console.log(`CPU instance: ${ollamaCpuUrl} (via x-compute-type: cpu header)`);
});
