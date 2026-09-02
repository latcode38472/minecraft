// Who this browser is, as far as the server is concerned.
//
// A random key is minted once and kept in localStorage; the server files a
// player's inventory, position and health under it, so the same person gets
// their things back when they rejoin a world — even after a reconnect that
// changed their session id.

import { PLAYER_KEY_PATTERN } from './protocol';

const KEY_STORAGE = 'voxelcraft.playerKey';

function mintKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The stable per-browser player key, created on first use. */
export function loadPlayerKey(): string {
  let key: string | null = null;
  try {
    key = localStorage.getItem(KEY_STORAGE);
  } catch {
    // Private mode or storage blocked: a fresh key per visit is the best we can do.
  }
  if (!key || !PLAYER_KEY_PATTERN.test(key)) {
    key = mintKey();
    try {
      localStorage.setItem(KEY_STORAGE, key);
    } catch {
      /* not persistable */
    }
  }
  return key;
}
