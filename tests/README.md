# Ollama Proxy - Test Suite

Complete testing documentation for the Ollama Proxy API server.

## 📋 Quick Reference

| Test Command | Category | Docker Required | Description |
|-------------|----------|----------------|-------------|
| `npm run test:unit` | Unit | ❌ No | Jest unit tests (API endpoints) |
| `npm run test:unit:watch` | Unit | ❌ No | Jest watch mode for development |
| `npm run test:unit:coverage` | Unit | ❌ No | Jest with coverage report |
| `npm run test:integration` | Integration | ✅ Yes | Integration tests (real LLM calls) |
| `npm run test:all` | Suite | ⚠️ Mixed | All automated tests |
| `npm run test:ci` | CI/CD | ❌ No | CI-optimized Jest tests |

---

## 🚀 Quick Start

### Prerequisites

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **For integration tests** (marked with ✅ above):
   ```bash
   # Start Ollama Docker containers
   docker-compose up -d

   # Pull the test model
   docker exec -it ollama-cpu ollama pull qwen2.5:0.5b

   # Wait for services to be healthy (~10 seconds)
   docker ps  # Check all services are "Up"
   ```

### Run All Tests

```bash
# Run unit tests only (no Docker required)
npm run test:unit

# Run all tests including integration (Docker required)
npm test
```

---

## 📁 Test Structure

```
/tests
├── /unit              # Jest unit tests (TypeScript)
│   └── /api           # API endpoint unit tests
│       ├── health.test.ts      # Health endpoint tests
│       └── chat.test.ts        # Chat completions logic tests
├── /integration       # Integration tests (TypeScript)
│   └── llm-call.test.ts        # Real LLM call tests
└── README.md          # This file
```

---

## 📊 Test Categories

### 🧪 Unit Tests (`npm run test:unit`)

**Framework**: Jest + ts-jest
**Location**: `tests/unit/`
**Docker Required**: ❌ No
**Duration**: ~2 seconds

**What's tested**:

#### Health Endpoint Tests ([health.test.ts](unit/api/health.test.ts))

Tests the `/health` endpoint functionality:

- ✅ Returns 200 with `{"status": "ok"}` when authenticated
- ✅ Returns 401 when no authorization header provided
- ✅ Returns 401 when wrong API key provided
- ✅ Has correct response structure
- ✅ Responds quickly (< 100ms)

**Expected Results**:
```
Test Suites: 1 passed, 1 total
Tests:       5 passed, 5 total
```

#### Chat Completions Tests ([chat.test.ts](unit/api/chat.test.ts))

Tests the OpenAI-compatible chat endpoint logic:

**Request Validation** (3 tests):
- ✅ Validates required fields in chat request
- ✅ Accepts valid message structure
- ✅ Works with hardcoded model name

**Response Structure** (3 tests):
- ✅ Has correct OpenAI response format
- ✅ Validates choice structure
- ✅ Validates usage statistics

**Model Routing** (3 tests):
- ✅ Routes llama2 to correct instance
- ✅ Routes small models to CPU
- ✅ Defaults unknown models to GPU

**Streaming Support** (3 tests):
- ✅ Accepts stream parameter
- ✅ Defaults to non-streaming
- ✅ Validates streaming chunk structure

**Error Handling** (3 tests):
- ✅ Validates error response structure
- ✅ Handles missing model parameter
- ✅ Handles empty messages array

**Expected Results**:
```
Test Suites: 1 passed, 1 total
Tests:       15 passed, 15 total
```

**Run Commands**:
```bash
npm run test:unit              # Run all unit tests
npm run test:unit:watch        # Watch mode for development
npm run test:unit:coverage     # With coverage report
```

---

### 🔗 Integration Tests (`npm run test:integration`)

**Location**: `tests/integration/`
**Docker Required**: ✅ Yes (Ollama containers must be running)
**Duration**: ~30-60 seconds

#### LLM Call Test ([llm-call.test.ts](integration/llm-call.test.ts))

**Model Used**: `qwen2.5:0.5b` (hardcoded small model for fast testing)

**What's tested**:

**Simple LLM Call** (3 tests):
1. ✅ Successfully calls LLM with hardcoded model (non-streaming)
2. ✅ Handles simple math question
3. ✅ Uses correct model routing (CPU for small model)

**Model List** (1 test):
4. ✅ Lists available models

**Error Handling** (2 tests):
5. ✅ Returns error for non-existent model
6. ✅ Returns 401 for missing API key

**Prerequisites**:
```bash
# 1. Start Docker containers
docker-compose up -d

# 2. Pull the test model
docker exec -it ollama-cpu ollama pull qwen2.5:0.5b

# 3. Configure PROXY_URL in .env (see Configuration section below)

# 4. Verify proxy is accessible
curl -H "Authorization: Bearer your-api-key" ${PROXY_URL}/health
```

**Expected Results**:
```
Test Suites: 1 passed, 1 total
Tests:       6 passed, 6 total
Duration:    ~30-60 seconds

✅ LLM responds to simple prompt
✅ Math question answered
✅ Model routing working
✅ Model list retrieved
✅ Error handling working
```

**Run Commands**:
```bash
npm run test:integration     # Run only integration tests
```

---

## ⚙️ Configuration

### Environment Variables

The tests use the following environment variables (with defaults):

```bash
# Proxy URL - REQUIRED for integration tests
# See .env.example for configuration options
PROXY_URL=https://ollama.yourdomain.com

# API Key for authentication (from your .env file)
API_KEY=your-api-key-here
```

### Important: Proxy URL Configuration

**The proxy port (3000) is NOT exposed to the host by default for security reasons.**

You have two options for running integration tests:

#### Option 1: Cloudflare Tunnel (RECOMMENDED)

Use your Cloudflare Tunnel URL configured in `cloudflare/config.yml`:

```bash
# .env
PROXY_URL=https://ollama.yourdomain.com
API_KEY=your-api-key-here
```

**Advantages:**
- ✅ No ports exposed to host (more secure)
- ✅ Tests against production-like environment
- ✅ Cloudflare security features active
- ✅ Works exactly like production

#### Option 2: Localhost with Port Mapping

Add port mapping to `docker-compose.yml` (or `docker-compose.nvidia.yml`):

```yaml
proxy:
  ports:
    - "3000:3000"  # Add this line
  build: .
  # ... rest of config
```

Then configure:

```bash
# .env
PROXY_URL=http://localhost:3000
API_KEY=your-api-key-here
```

**Disadvantages:**
- ⚠️ Exposes port 3000 on your host machine
- ⚠️ Additional attack surface
- ⚠️ Different from production setup

---

## ⚠️ Common Issues and Solutions

### "Cannot connect to proxy" / "ECONNREFUSED localhost:3000"

**Cause**: Proxy port not exposed to host (this is intentional for security)

**Solutions:**

1. **Use Cloudflare Tunnel (RECOMMENDED)**:
   ```bash
   # In .env
   PROXY_URL=https://ollama.yourdomain.com
   ```

2. **Temporarily add port mapping for testing**:
   ```yaml
   # In docker-compose.yml
   proxy:
     ports:
       - "3000:3000"
   ```
   Then restart: `docker-compose down && docker-compose up -d`

3. **Check if proxy container is running**:
   ```bash
   docker ps | grep proxy
   # Should show: ollama-proxy-proxy-1
   ```

### "Model not found" errors

**Cause**: Test model not pulled
**Solution**:
```bash
# Pull the test model to CPU instance
docker exec -it ollama-cpu ollama pull qwen2.5:0.5b

# Verify model is available
docker exec -it ollama-cpu ollama list
```

### "ECONNREFUSED" or "connect ETIMEDOUT" errors

**Cause**: Either:
1. Ollama containers not running, OR
2. Proxy port not accessible (not mapped to host)

**Solution**:
```bash
# 1. Check container status
docker ps

# 2. Start containers if needed
docker-compose up -d

# 3. Configure PROXY_URL in .env
#    Use Cloudflare Tunnel URL (recommended)
#    OR add port mapping to docker-compose.yml

# 4. Check logs
docker-compose logs -f proxy
```

### Integration tests timeout

**Cause**: LLM taking longer than expected
**Solution**:
- Test timeout is set to 30 seconds (configurable in test files)
- First LLM call may be slower (model loading)
- Subsequent calls should be faster

---

## 🔬 Development Workflow

### Before Committing
```bash
# Format and lint
npm run lint

# Run unit tests (fast)
npm run test:unit

# Run all tests
npm test
```

### During Development
```bash
# Watch mode for quick feedback
npm run test:unit:watch

# Run specific test file
npx jest tests/unit/api/health.test.ts
```

### Before Releasing
```bash
# Full test suite with coverage
npm run test:unit:coverage
npm run test:integration
```

---

## 📈 Adding New Tests

### 1. Create Test File

**For Unit Tests**:
```bash
# Create in tests/unit/api/
touch tests/unit/api/my-feature.test.ts
```

**For Integration Tests**:
```bash
# Create in tests/integration/
touch tests/integration/my-feature.test.ts
```

### 2. Write Test

```typescript
// tests/unit/api/my-feature.test.ts
import { describe, it, expect } from '@jest/globals';

describe('My Feature', () => {
  it('should do something', () => {
    expect(true).toBe(true);
  });
});
```

### 3. Run Test

```bash
# Run specific test
npx jest tests/unit/api/my-feature.test.ts

# Run all unit tests
npm run test:unit
```

---

## 📈 Continuous Integration

For CI/CD pipelines, use:

```bash
npm run test:ci  # Jest with CI optimization
```

This runs tests with:
- `--runInBand` (sequential execution)
- `--ci` (optimized for CI environments)
- `--coverage` (generates coverage reports)

**GitHub Actions Example**:
```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run unit tests
        run: npm run test:unit:coverage

      - name: Start Ollama services
        run: docker-compose up -d

      - name: Wait for services
        run: sleep 10

      - name: Pull test model
        run: docker exec ollama-cpu ollama pull qwen2.5:0.5b

      - name: Run integration tests
        run: npm run test:integration

      - name: Upload coverage
        uses: codecov/codecov-action@v3
```

---

## 🎯 Test Coverage Goals

- **Unit Tests**: 80%+ code coverage
- **Integration Tests**: 100% pass rate (all endpoints working)
- **Response Time**: Health < 100ms, LLM < 30s

---

## 📚 Test Examples

### Unit Test Example

```typescript
// tests/unit/api/health.test.ts
import { describe, it, expect } from '@jest/globals';
import request from 'supertest';

describe('Health Endpoint', () => {
  it('should return 200 with status ok', async () => {
    const response = await request(app)
      .get('/health')
      .set('Authorization', 'Bearer test-api-key');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
```

### Integration Test Example

```typescript
// tests/integration/llm-call.test.ts
import { describe, it, expect } from '@jest/globals';
import fetch from 'node-fetch';

describe('LLM Call', () => {
  it('should call LLM successfully', async () => {
    const response = await fetch('http://localhost:3000/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-api-key',
      },
      body: JSON.stringify({
        model: 'qwen2.5:0.5b',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.choices[0].message.content).toBeTruthy();
  });
});
```

---

## 📞 Support

If tests consistently fail:

1. ✅ **Check prerequisites** (Docker running, model pulled)
2. ✅ **Review test output** for specific error messages
3. ✅ **Check service logs** with `docker-compose logs -f`
4. ✅ **Verify environment** variables
5. ✅ **Consult troubleshooting** section above
6. ✅ **Open issue** with test output and environment details

---

## 🎓 Useful Commands

```bash
# Test commands
npm run test:unit              # Unit tests only
npm run test:integration       # Integration tests only
npm test                       # All tests
npm run test:unit:watch        # Watch mode
npm run test:unit:coverage     # With coverage

# Docker commands
docker-compose up -d           # Start services
docker-compose down            # Stop services
docker-compose logs -f         # View logs
docker ps                      # Check status

# Ollama commands
docker exec ollama-cpu ollama list           # List CPU models
docker exec ollama-gpu ollama list           # List GPU models
docker exec ollama-cpu ollama pull MODEL     # Pull model to CPU
docker exec ollama-gpu ollama pull MODEL     # Pull model to GPU

# Development
npm run dev                    # Start in dev mode
npm run build                  # Build TypeScript
npm run lint                   # Run linter
```

---

<div align="center">

**Happy Testing! 🧪**

Made with ❤️ for the Ollama Proxy

**OpenAI-Compatible API for Ollama ✅**

</div>
