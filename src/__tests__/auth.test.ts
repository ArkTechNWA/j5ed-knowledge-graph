import { parseCredentials } from '../utils/config.js';
import { authenticateRequest } from '../index.js';

describe('parseCredentials', () => {
  it('parses comma-separated agent:token pairs', () => {
    const result = parseCredentials('j5:abc123,ephe:def456');
    expect(result).toEqual(new Map([
      ['abc123', 'j5'],
      ['def456', 'ephe'],
    ]));
  });

  it('returns empty map for undefined input', () => {
    const result = parseCredentials(undefined);
    expect(result).toEqual(new Map());
  });

  it('trims whitespace', () => {
    const result = parseCredentials(' j5 : abc123 , ephe : def456 ');
    expect(result).toEqual(new Map([
      ['abc123', 'j5'],
      ['def456', 'ephe'],
    ]));
  });

  it('skips malformed entries', () => {
    const result = parseCredentials('j5:abc123,badentry,ephe:def456');
    expect(result).toEqual(new Map([
      ['abc123', 'j5'],
      ['def456', 'ephe'],
    ]));
  });
});

describe('authenticateRequest', () => {
  const credentials = new Map([
    ['abc123', 'j5'],
    ['def456', 'ephe'],
  ]);

  it('returns agentId for valid Bearer token', () => {
    const result = authenticateRequest('Bearer abc123', credentials);
    expect(result).toEqual({ authenticated: true, agentId: 'j5' });
  });

  it('rejects missing Authorization header', () => {
    const result = authenticateRequest(undefined, credentials);
    expect(result).toEqual({ authenticated: false, error: 'Authorization header required' });
  });

  it('rejects invalid token', () => {
    const result = authenticateRequest('Bearer badtoken', credentials);
    expect(result).toEqual({ authenticated: false, error: 'Invalid token' });
  });

  it('rejects non-Bearer scheme', () => {
    const result = authenticateRequest('Basic abc123', credentials);
    expect(result).toEqual({ authenticated: false, error: 'Bearer token required' });
  });

  it('allows all when credentials map is empty (auth disabled)', () => {
    const result = authenticateRequest(undefined, new Map());
    expect(result).toEqual({ authenticated: true, agentId: undefined });
  });
});
