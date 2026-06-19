import { describe, expect, it } from 'vitest';
import { detectLanguage } from './codeLanguage';

describe('detectLanguage', () => {
  it('defaults to tsx for null or unknown extensions', () => {
    expect(detectLanguage(null)).toBe('tsx');
    expect(detectLanguage('README')).toBe('tsx');
    expect(detectLanguage('mystery.xyz')).toBe('tsx');
  });

  it('maps the JS/TS family', () => {
    expect(detectLanguage('App.tsx')).toBe('tsx');
    expect(detectLanguage('store.ts')).toBe('typescript');
    expect(detectLanguage('view.jsx')).toBe('jsx');
    expect(detectLanguage('main.js')).toBe('javascript');
    expect(detectLanguage('a.mjs')).toBe('javascript');
    expect(detectLanguage('b.cjs')).toBe('javascript');
  });

  it('is case-insensitive', () => {
    expect(detectLanguage('Main.TS')).toBe('typescript');
    expect(detectLanguage('STYLE.CSS')).toBe('css');
  });

  it('maps common back-end languages', () => {
    expect(detectLanguage('app.py')).toBe('python');
    expect(detectLanguage('lib.rb')).toBe('ruby');
    expect(detectLanguage('main.go')).toBe('go');
    expect(detectLanguage('lib.rs')).toBe('rust');
    expect(detectLanguage('Main.java')).toBe('java');
  });

  it('maps markup/style/config formats', () => {
    expect(detectLanguage('index.html')).toBe('markup');
    expect(detectLanguage('icon.svg')).toBe('markup');
    expect(detectLanguage('styles.scss')).toBe('scss');
    expect(detectLanguage('data.yaml')).toBe('yaml');
    expect(detectLanguage('Cargo.toml')).toBe('toml');
    expect(detectLanguage('notes.md')).toBe('markdown');
  });

  it('maps C-family headers and sources', () => {
    expect(detectLanguage('main.c')).toBe('c');
    expect(detectLanguage('header.h')).toBe('c');
    expect(detectLanguage('app.cpp')).toBe('cpp');
    expect(detectLanguage('app.hpp')).toBe('cpp');
  });

  it('maps shell and Dockerfile', () => {
    expect(detectLanguage('deploy.sh')).toBe('bash');
    expect(detectLanguage('run.zsh')).toBe('bash');
    expect(detectLanguage('Dockerfile')).toBe('docker');
    expect(detectLanguage('web.dockerfile')).toBe('docker');
  });
});
