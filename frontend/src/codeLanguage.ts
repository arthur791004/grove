import type { Language } from 'prism-react-renderer';

// Map filename to a Prism language id. prism-react-renderer ships ~20 langs
// out of the box; falls back to plain rendering for unknown extensions.
export function detectLanguage(file: string | null): Language {
  if (!file) return 'tsx';
  const lower = file.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts')) return 'typescript';
  if (lower.endsWith('.jsx')) return 'jsx';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs'))
    return 'javascript';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.rb')) return 'ruby';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.rs')) return 'rust';
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.kt')) return 'kotlin';
  if (lower.endsWith('.swift')) return 'swift';
  if (lower.endsWith('.c') || lower.endsWith('.h')) return 'c';
  if (lower.endsWith('.cpp') || lower.endsWith('.cc') || lower.endsWith('.hpp')) return 'cpp';
  if (lower.endsWith('.css')) return 'css';
  if (lower.endsWith('.scss') || lower.endsWith('.sass')) return 'scss';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'markup';
  if (lower.endsWith('.xml') || lower.endsWith('.svg')) return 'markup';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (lower.endsWith('.toml')) return 'toml';
  if (lower.endsWith('.sh') || lower.endsWith('.bash') || lower.endsWith('.zsh')) return 'bash';
  if (lower.endsWith('dockerfile') || lower.endsWith('.dockerfile')) return 'docker';
  if (lower.endsWith('.sql')) return 'sql';
  if (lower.endsWith('.graphql') || lower.endsWith('.gql')) return 'graphql';
  return 'tsx';
}
