// Decide whether a URL should open in the embedded browser panel
// (local/dev) or punt to the OS default browser (anything else).
// Local-ish heuristics: any hostname containing "localhost", the usual
// loopback IPs, or any non-standard port (dev servers).
export function isLocalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname;
    if (h.includes('localhost') || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1') {
      return true;
    }
    if (u.port && u.port !== '80' && u.port !== '443') return true;
    return false;
  } catch {
    return false;
  }
}
