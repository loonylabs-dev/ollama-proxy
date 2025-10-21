/**
 * Health Endpoint Unit Tests
 * Tests the basic health check endpoint functionality
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

// Mock Express app with health endpoint
const createTestApp = () => {
  const app = express();

  // Mock auth middleware
  const authenticate = (req: Request, res: Response, next: NextFunction) => {
    const auth = req.headers['authorization'];
    const apiKey = 'test-api-key';

    if (!apiKey || auth !== `Bearer ${apiKey}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };

  // Health endpoint (same as in main app)
  app.get('/health', authenticate, (req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  return app;
};

describe('Health Endpoint', () => {
  let app: express.Application;

  beforeAll(() => {
    app = createTestApp();
  });

  describe('GET /health', () => {
    it('should return 200 with status ok when authenticated', async () => {
      const response = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-api-key');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('should return 401 when no authorization header is provided', async () => {
      const response = await request(app)
        .get('/health');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
    });

    it('should return 401 when wrong API key is provided', async () => {
      const response = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer wrong-key');

      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: 'Unauthorized' });
    });

    it('should have correct response structure', async () => {
      const response = await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-api-key');

      expect(response.body).toHaveProperty('status');
      expect(typeof response.body.status).toBe('string');
    });

    it('should respond quickly (< 100ms)', async () => {
      const startTime = Date.now();

      await request(app)
        .get('/health')
        .set('Authorization', 'Bearer test-api-key');

      const endTime = Date.now();
      const duration = endTime - startTime;

      expect(duration).toBeLessThan(100);
    });
  });
});
