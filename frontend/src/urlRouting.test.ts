import { describe, expect, it } from 'vitest';
import { isLocalUrl } from './urlRouting';

describe('isLocalUrl', () => {
  it('treats localhost (any form) as local', () => {
    expect(isLocalUrl('http://localhost/')).toBe(true);
    expect(isLocalUrl('http://localhost:3000/app')).toBe(true);
    expect(isLocalUrl('https://my-localhost.test/')).toBe(true);
  });

  it('treats loopback IPs as local', () => {
    expect(isLocalUrl('http://127.0.0.1/')).toBe(true);
    expect(isLocalUrl('http://0.0.0.0:8080/')).toBe(true);
    expect(isLocalUrl('http://[::1]:5173/')).toBe(true);
  });

  it('treats any non-standard port as a dev server (local)', () => {
    expect(isLocalUrl('http://example.com:3000/')).toBe(true);
    expect(isLocalUrl('https://example.com:8443/')).toBe(true);
  });

  it('treats standard-port public hosts as non-local', () => {
    expect(isLocalUrl('http://example.com/')).toBe(false);
    expect(isLocalUrl('https://example.com/')).toBe(false);
    expect(isLocalUrl('http://example.com:80/')).toBe(false);
    expect(isLocalUrl('https://example.com:443/')).toBe(false);
  });

  it('returns false for unparseable input', () => {
    expect(isLocalUrl('not a url')).toBe(false);
    expect(isLocalUrl('')).toBe(false);
  });
});
