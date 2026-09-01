// Where the multiplayer server lives.
//
// Resolution order, first match wins:
//   1. ?server=  query parameter          (quick phone testing, no rebuild)
//   2. VITE_MULTIPLAYER_URL build env     (deployment)
//   3. same host as the page, port 8787   (LAN dev: phone hits the dev machine)
//
// Nothing hardcodes "localhost", so opening the game from a phone at
// http://192.168.1.20:5173 automatically targets ws://192.168.1.20:8787.

export const DEFAULT_SERVER_PORT = 8787;

function fromEnv(): string | null {
  const url = import.meta.env?.VITE_MULTIPLAYER_URL;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

function fromQuery(): string | null {
  const raw = new URLSearchParams(location.search).get('server');
  if (!raw) return null;
  // Accept a bare host:port as well as a full ws:// URL.
  if (/^wss?:\/\//i.test(raw)) return raw;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${raw}`;
}

function sameHostDefault(): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = location.hostname || 'localhost';
  return `${scheme}://${host}:${DEFAULT_SERVER_PORT}`;
}

export function resolveServerUrl(): string {
  return fromQuery() ?? fromEnv() ?? sameHostDefault();
}

/** Human-readable host for the connection status line. */
export function describeServer(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch {
    return url;
  }
}
