/**
 * LLM Call Integration Test
 * Tests actual LLM calls with a hardcoded model against running Ollama instance
 *
 * Prerequisites:
 * - Docker containers must be running (docker-compose up -d)
 * - Model 'qwen2.5:0.5b' must be pulled (ollama pull qwen2.5:0.5b)
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import fetch from 'node-fetch';

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || 'test-api-key';
const TEST_MODEL = 'gemma3:4b'; // Hardcoded small model for fast testing

describe('LLM Call Integration Tests', () => {
  beforeAll(async () => {
    // Check if proxy is running
    try {
      const response = await fetch(`${PROXY_URL}/health`, {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
        },
      });

      if (!response.ok) {
        throw new Error('Proxy health check failed');
      }
    } catch (error) {
      console.error('Failed to connect to proxy. Make sure docker-compose is running.');
      throw error;
    }
  });

  describe('Simple LLM Call', () => {
    it('should successfully call LLM with hardcoded model (non-streaming)', async () => {
      const response = await fetch(`${PROXY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: TEST_MODEL,
          messages: [
            {
              role: 'user',
              content: 'Say "Hello World" and nothing else.',
            },
          ],
          stream: false,
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json() as any;

      // Validate OpenAI-compatible response structure
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('object');
      expect(data).toHaveProperty('created');
      expect(data).toHaveProperty('model');
      expect(data).toHaveProperty('choices');
      expect(data).toHaveProperty('usage');

      expect(data.object).toBe('chat.completion');
      expect(Array.isArray(data.choices)).toBe(true);
      expect(data.choices.length).toBeGreaterThan(0);

      // Validate first choice
      const choice = data.choices[0];
      expect(choice).toHaveProperty('index');
      expect(choice).toHaveProperty('message');
      expect(choice).toHaveProperty('finish_reason');

      expect(choice.message).toHaveProperty('role');
      expect(choice.message).toHaveProperty('content');
      expect(choice.message.role).toBe('assistant');
      expect(typeof choice.message.content).toBe('string');
      expect(choice.message.content.length).toBeGreaterThan(0);

      // Validate usage
      expect(data.usage).toHaveProperty('prompt_tokens');
      expect(data.usage).toHaveProperty('completion_tokens');
      expect(data.usage).toHaveProperty('total_tokens');
      expect(data.usage.total_tokens).toBeGreaterThan(0);

      console.log(`LLM Response: ${choice.message.content}`);
    }, 30000); // 30 second timeout for LLM call

    it('should handle simple math question', async () => {
      const response = await fetch(`${PROXY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: TEST_MODEL,
          messages: [
            {
              role: 'user',
              content: 'What is 2+2? Answer with just the number.',
            },
          ],
          stream: false,
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json() as any;
      const answer = data.choices[0].message.content;

      expect(answer).toBeTruthy();
      console.log(`Math answer: ${answer}`);
    }, 30000);

    it('should use correct model routing (CPU for small model)', async () => {
      const response = await fetch(`${PROXY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: TEST_MODEL,
          messages: [
            {
              role: 'user',
              content: 'Hi',
            },
          ],
          stream: false,
        }),
      });

      expect(response.status).toBe(200);

      const data = await response.json() as any;

      // Model in response should match requested model
      expect(data.model).toBe(TEST_MODEL);
    }, 30000);
  });

  describe('Model List', () => {
    it('should list available models', async () => {
      const response = await fetch(`${PROXY_URL}/v1/models`, {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
        },
      });

      expect(response.status).toBe(200);

      const data = await response.json() as any;

      expect(data).toHaveProperty('object');
      expect(data).toHaveProperty('data');
      expect(data.object).toBe('list');
      expect(Array.isArray(data.data)).toBe(true);

      // Check if our test model is in the list
      const hasTestModel = data.data.some((model: any) => model.id === TEST_MODEL);
      console.log(`Available models: ${data.data.map((m: any) => m.id).join(', ')}`);

      if (!hasTestModel) {
        console.warn(`Test model ${TEST_MODEL} not found. Please run: ollama pull ${TEST_MODEL}`);
      }
    });
  });

  describe('Error Handling', () => {
    it('should return error for non-existent model', async () => {
      const response = await fetch(`${PROXY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: 'non-existent-model-xyz',
          messages: [
            {
              role: 'user',
              content: 'Hello',
            },
          ],
          stream: false,
        }),
      });

      // Should get an error response
      expect([404, 500]).toContain(response.status);

      const data = await response.json() as any;
      expect(data).toHaveProperty('error');
    }, 30000);

    it('should return 401 for missing API key', async () => {
      const response = await fetch(`${PROXY_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: TEST_MODEL,
          messages: [
            {
              role: 'user',
              content: 'Hello',
            },
          ],
        }),
      });

      expect(response.status).toBe(401);
    });
  });
});
