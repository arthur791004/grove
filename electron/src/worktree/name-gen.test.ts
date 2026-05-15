import { describe, expect, it } from 'vitest';
import { displayName, generateBranchName } from './name-gen';

describe('generateBranchName', () => {
  it('matches grove/<animal>-<4hex>', () => {
    for (let i = 0; i < 50; i++) {
      const branch = generateBranchName();
      expect(branch).toMatch(/^grove\/[a-z]+-[0-9a-f]{4}$/);
    }
  });

  it('produces enough variety to avoid collisions in normal use', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateBranchName());
    // 60 animals × 65536 hashes = ~4M combinations — across 1000 picks the
    // birthday-paradox expectation is ~12 collisions. Allow a comfortable
    // margin (<5% collisions) for occasional bad luck.
    expect(seen.size).toBeGreaterThan(950);
  });
});

describe('displayName', () => {
  it('strips the grove/ prefix', () => {
    expect(displayName('grove/otter-a3f2')).toBe('otter-a3f2');
  });

  it('passes through branches without the prefix', () => {
    expect(displayName('main')).toBe('main');
    expect(displayName('feature/x')).toBe('feature/x');
  });
});
