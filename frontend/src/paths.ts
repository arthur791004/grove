// Display-only path shortening — replaces the user's home dir with `~`.
// Use for any UI surface that shows a filesystem path; the absolute path is
// only kept for clipboard / IPC payloads.
export function shortPath(p: string): string {
  if (!p) return p;
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}
