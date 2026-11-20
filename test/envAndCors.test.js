import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { validateProductionEnv } from '../src/env.js';
import { isAllowedOrigin } from '../src/cors.js';
import { createApp } from '../src/app.js';

describe('Production Environment Validation (src/env.js)', () => {
  const baseValidProdEnv = {
    NODE_ENV: 'production',
    LIVEKIT_URL: 'wss://my-company.livekit.cloud',
    LIVEKIT_API_KEY: 'APIPROD12345678',
    LIVEKIT_API_SECRET: 'SECRET9876543210123456789',
    HOST_PASSCODE: 'SuperSecurePasscode!2026',
    API_TOKEN_SECRET: 'TokenSigningSecret1234567890'
  };

  it('passes when all required variables are set to secure values', () => {
    expect(() => validateProductionEnv(baseValidProdEnv)).not.toThrow();
  });

  it('ignores missing variables in development mode', () => {
    expect(() => validateProductionEnv({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('rejects missing LIVEKIT_URL with variable name', () => {
    const env = { ...baseValidProdEnv, LIVEKIT_URL: '' };
    expect(() => validateProductionEnv(env)).toThrow(/Missing required production environment variable.*LIVEKIT_URL/);
  });

  it('rejects devkey LIVEKIT_API_KEY with variable name', () => {
    const env = { ...baseValidProdEnv, LIVEKIT_API_KEY: 'devkey' };
    expect(() => validateProductionEnv(env)).toThrow(/LIVEKIT_API_KEY/);
  });

  it('rejects default secret LIVEKIT_API_SECRET with variable name', () => {
    const env = { ...baseValidProdEnv, LIVEKIT_API_SECRET: 'secret' };
    expect(() => validateProductionEnv(env)).toThrow(/LIVEKIT_API_SECRET/);
  });

  it('rejects weak default HOST_PASSCODE "1234" in production', () => {
    const env = { ...baseValidProdEnv, HOST_PASSCODE: '1234' };
    expect(() => validateProductionEnv(env)).toThrow(/Insecure HOST_PASSCODE in production: default "1234" is rejected/);
  });

  it('rejects missing token signing secret in production', () => {
    const env = { ...baseValidProdEnv, API_TOKEN_SECRET: '', LIVEKIT_API_SECRET: '' };
    expect(() => validateProductionEnv(env)).toThrow(/API_TOKEN_SECRET or LIVEKIT_API_SECRET/);
  });
});

describe('CORS and WebSocket Origin Validation (src/cors.js)', () => {
  it('allows non-browser requests without origin (curl, scripts)', () => {
    expect(isAllowedOrigin(undefined, { NODE_ENV: 'production' })).toBe(true);
  });

  it('allows origins explicitly listed in ALLOWED_ORIGINS', () => {
    const env = {
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://eventmic.live,https://app.eventmic.live'
    };
    expect(isAllowedOrigin('https://eventmic.live', env)).toBe(true);
    expect(isAllowedOrigin('https://app.eventmic.live', env)).toBe(true);
    expect(isAllowedOrigin('https://malicious.com', env)).toBe(false);
  });

  it('supports wildcard * in ALLOWED_ORIGINS', () => {
    const env = { NODE_ENV: 'production', ALLOWED_ORIGINS: '*' };
    expect(isAllowedOrigin('https://any-domain.com', env)).toBe(true);
  });

  it('supports Vercel previews when ALLOW_VERCEL_PREVIEWS=true', () => {
    const env = {
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://eventmic.live',
      ALLOW_VERCEL_PREVIEWS: 'true'
    };
    expect(isAllowedOrigin('https://eventmic-web-preview.vercel.app', env)).toBe(true);
    expect(isAllowedOrigin('https://eventmic-git-feat-xyz-team.vercel.app', env)).toBe(true);
    expect(isAllowedOrigin('https://evil-site.com', env)).toBe(false);
  });

  it('blocks Vercel previews when ALLOW_VERCEL_PREVIEWS is false or omitted', () => {
    const env = {
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://eventmic.live'
    };
    expect(isAllowedOrigin('https://eventmic-web-preview.vercel.app', env)).toBe(false);
  });

  it('defaults to allowing all in development mode when ALLOWED_ORIGINS not set', () => {
    expect(isAllowedOrigin('http://localhost:5173', { NODE_ENV: 'development' })).toBe(true);
  });
});

describe('Health Endpoint (GET /api/health)', () => {
  it('returns ok, version, uptimeSec, livekitConfigured, socketEnabled, sessions with no secrets', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.version).toBeDefined();
    expect(typeof res.body.uptimeSec).toBe('number');
    expect(typeof res.body.livekitConfigured).toBe('boolean');
    expect(res.body.socketEnabled).toBe(true);
    expect(typeof res.body.sessions).toBe('number');

    // Confirm no secrets or URLs with keys are leaked
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/secret|key|passcode|token/i);
  });
});
