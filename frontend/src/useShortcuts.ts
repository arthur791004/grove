import { useEffect } from 'react';
import { useStore } from './store';

export function useShortcuts(openPalette: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      // ⌘T new tab
      if (e.key === 't' && !e.shiftKey) {
        e.preventDefault();
        useStore.getState().newTab();
        return;
      }
      // ⌘W close active tab
      if (e.key === 'w' && !e.shiftKey) {
        e.preventDefault();
        const id = useStore.getState().activeTabId;
        if (id) useStore.getState().closeTab(id);
        return;
      }
      // ⌘P fuzzy tab search
      if (e.key === 'p' && !e.shiftKey) {
        e.preventDefault();
        openPalette();
        return;
      }
      // ⌘\ toggle sidebar
      if (e.key === '\\') {
        e.preventDefault();
        useStore.getState().toggleSidebar();
        return;
      }
      // ⌘1..9 jump to tab N across flat order
      if (/^[1-9]$/.test(e.key) && !e.shiftKey) {
        e.preventDefault();
        const s = useStore.getState();
        const flat: string[] = [];
        for (const gid of s.groupOrder) {
          for (const tid of s.tabOrderByGroup[gid] ?? []) flat.push(tid);
        }
        const idx = parseInt(e.key, 10) - 1;
        if (flat[idx]) s.setActiveTab(flat[idx]);
        return;
      }
      // ⌘⇧[ / ⌘⇧] cycle tabs
      if (e.shiftKey && (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}')) {
        e.preventDefault();
        const s = useStore.getState();
        const flat: string[] = [];
        for (const gid of s.groupOrder) {
          for (const tid of s.tabOrderByGroup[gid] ?? []) flat.push(tid);
        }
        if (flat.length === 0) return;
        const i = s.activeTabId ? flat.indexOf(s.activeTabId) : 0;
        const dir = e.key === ']' || e.key === '}' ? 1 : -1;
        const next = flat[(i + dir + flat.length) % flat.length];
        s.setActiveTab(next);
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPalette]);
}
