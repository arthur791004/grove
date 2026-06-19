import { describe, expect, it } from 'vitest';
import { shortPath } from './paths';

describe('shortPath', () => {
  it('replaces a macOS home dir with ~', () => {
    expect(shortPath('/Users/arthur/code/grove')).toBe('~/code/grove');
  });

  it('replaces a Linux home dir with ~', () => {
    expect(shortPath('/home/arthur/code/grove')).toBe('~/code/grove');
  });

  it('collapses the home dir itself to ~', () => {
    expect(shortPath('/Users/arthur')).toBe('~');
    expect(shortPath('/home/arthur')).toBe('~');
  });

  it('only rewrites a leading home prefix, not occurrences mid-path', () => {
    expect(shortPath('/var/Users/arthur/x')).toBe('/var/Users/arthur/x');
  });

  it('leaves unrelated absolute paths untouched', () => {
    expect(shortPath('/etc/hosts')).toBe('/etc/hosts');
    expect(shortPath('/opt/tool/bin')).toBe('/opt/tool/bin');
  });

  it('handles a different username under the home root', () => {
    expect(shortPath('/Users/someone-else/Documents')).toBe('~/Documents');
  });

  it('returns falsy input unchanged', () => {
    expect(shortPath('')).toBe('');
  });

  it('does not rewrite a path that only shares the /Users prefix without a user segment', () => {
    expect(shortPath('/Users')).toBe('/Users');
  });
});
