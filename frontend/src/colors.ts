import type { TabColor } from './store';

export const COLOR_HEX: Record<TabColor, string> = {
  default: '#7d8590',
  red: '#f85149',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
};

export const COLOR_ORDER: TabColor[] = ['default', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan'];
