// Mode-select and multiplayer lobby UI.
//
// showModeMenu() resolves once the player has chosen singleplayer, or has
// successfully created/joined a room — so main.ts can build the world knowing
// which seed to use. All controls are pointer-event based and sized for touch,
// so the same UI works on a phone and a desktop.

import { NetClient } from '../net/client';
import { describeServer, resolveServerUrl } from '../net/config';
import {
  MAX_PLAYERS,
  NAME_MAX_LENGTH,
  PROTOCOL_VERSION,
  ROOM_CODE_LENGTH,
  sanitizeName,
  type PlayerInfo,
  type ServerMessage,
  type WorldInfo,
} from '../net/protocol';

const NAME_STORAGE_KEY = 'voxelcraft.playerName';

export interface MultiplayerStart {
  mode: 'multiplayer';
  net: NetClient;
  code: string;
  self: PlayerInfo;
  world: WorldInfo;
  players: PlayerInfo[];
}

export type StartChoice = { mode: 'singleplayer' } | MultiplayerStart;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export function loadPlayerName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function savePlayerName(name: string): void {
  try {
    localStorage.setItem(NAME_STORAGE_KEY, name);
  } catch {
    /* private mode: not worth failing over */
  }
}

/**
 * Run the start menu. Resolves with the chosen mode; for multiplayer the
 * returned NetClient is already connected and in a room.
 */
export function showModeMenu(): Promise<StartChoice> {
  const root = el('start-menu');
  const panelMode = el('menu-mode');
  const panelMp = el('menu-mp');
  const nameInput = el<HTMLInputElement>('mp-name');
  const codeInput = el<HTMLInputElement>('mp-code');
  const statusEl = el('mp-status');
  const errorEl = el('mp-error');
  const lobbyEl = el('mp-lobby');
  const lobbyCodeEl = el('mp-lobby-code');
  const lobbyCountEl = el('mp-lobby-count');
  const lobbyListEl = el('mp-lobby-list');
  const serverEl = el('mp-server');
  const startBtn = el<HTMLButtonElement>('mp-start');

  nameInput.value = loadPlayerName();
  nameInput.maxLength = NAME_MAX_LENGTH;
  codeInput.maxLength = ROOM_CODE_LENGTH;

  const serverUrl = resolveServerUrl();
  serverEl.textContent = describeServer(serverUrl);

  root.style.display = 'flex';
  panelMode.style.display = 'flex';
  panelMp.style.display = 'none';

  return new Promise<StartChoice>((resolve) => {
    let net: NetClient | null = null;
    let settled = false;

    const setError = (message: string): void => {
      errorEl.textContent = message;
      errorEl.style.display = message ? 'block' : 'none';
    };
    const setStatus = (message: string): void => {
      statusEl.textContent = message;
    };
    const busy = (on: boolean): void => {
      for (const id of ['mp-create', 'mp-join']) {
        el<HTMLButtonElement>(id).disabled = on;
      }
    };

    const finish = (choice: StartChoice): void => {
      if (settled) return;
      settled = true;
      root.style.display = 'none';
      resolve(choice);
    };

    const cleanupNet = (): void => {
      if (net) {
        net.onMessage = null;
        net.onStatusChange = null;
        net.close();
        net = null;
      }
    };

    // --- Mode panel ---
    el('mode-single').addEventListener('click', () => finish({ mode: 'singleplayer' }));
    el('mode-multi').addEventListener('click', () => {
      panelMode.style.display = 'none';
      panelMp.style.display = 'flex';
      setError('');
      setStatus('Not connected');
    });
    el('mp-back').addEventListener('click', () => {
      cleanupNet();
      lobbyEl.style.display = 'none';
      panelMp.style.display = 'none';
      panelMode.style.display = 'flex';
    });

    /** Open a socket (or reuse the open one) and return it. */
    const ensureConnected = async (): Promise<NetClient> => {
      if (net?.isOpen) return net;
      cleanupNet();
      const client = new NetClient(serverUrl);
      net = client;
      setStatus(`Connecting to ${describeServer(serverUrl)}…`);
      await client.connect();
      setStatus('Connected');
      return client;
    };

    const currentName = (): string => {
      const name = sanitizeName(nameInput.value);
      savePlayerName(name);
      nameInput.value = name;
      return name;
    };

    /** Wait for the server's answer to a create/join attempt. */
    const awaitRoom = (client: NetClient): Promise<MultiplayerStart> =>
      new Promise((resolveRoom, rejectRoom) => {
        const timeout = window.setTimeout(() => {
          client.onMessage = null;
          rejectRoom(new Error('The server did not respond. Try again.'));
        }, 10_000);

        client.onMessage = (msg: ServerMessage) => {
          if (msg.t === 'room_created' || msg.t === 'join_success') {
            clearTimeout(timeout);
            client.onMessage = null;
            resolveRoom({
              mode: 'multiplayer',
              net: client,
              code: msg.code,
              self: msg.self,
              world: msg.world,
              players: msg.players,
            });
          } else if (msg.t === 'join_error') {
            clearTimeout(timeout);
            client.onMessage = null;
            rejectRoom(new Error(msg.message));
          }
        };
      });

    /** Lobby: shown to the host so they can share the code before starting. */
    const showLobby = (start: MultiplayerStart): void => {
      lobbyEl.style.display = 'flex';
      lobbyCodeEl.textContent = start.code;
      const render = (players: PlayerInfo[]): void => {
        lobbyCountEl.textContent = `Players: ${players.length} / ${MAX_PLAYERS}`;
        lobbyListEl.replaceChildren(
          ...players.map((p) => {
            const row = document.createElement('li');
            row.textContent = p.isHost ? `${p.name} (host)` : p.name;
            return row;
          }),
        );
      };
      render(start.players);

      // Keep the lobby live while the host waits for friends.
      start.net.onMessage = (msg: ServerMessage) => {
        if (msg.t === 'player_joined' || msg.t === 'player_left') {
          start.players = msg.players;
          render(msg.players);
        } else if (msg.t === 'room_closed') {
          setError(msg.message);
          lobbyEl.style.display = 'none';
        }
      };

      startBtn.onclick = () => {
        start.net.onMessage = null;
        finish(start);
      };
    };

    el('mp-create').addEventListener('click', async () => {
      setError('');
      busy(true);
      try {
        const client = await ensureConnected();
        client.send({ t: 'create_room', name: currentName(), version: PROTOCOL_VERSION });
        const start = await awaitRoom(client);
        setStatus('Room created');
        showLobby(start);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not create the room.');
        setStatus('Not connected');
      } finally {
        busy(false);
      }
    });

    el('mp-join').addEventListener('click', async () => {
      setError('');
      const code = codeInput.value.trim().toUpperCase();
      if (code.length !== ROOM_CODE_LENGTH) {
        setError(`Enter the ${ROOM_CODE_LENGTH}-character room code.`);
        return;
      }
      busy(true);
      try {
        const client = await ensureConnected();
        client.send({ t: 'join_room', code, name: currentName(), version: PROTOCOL_VERSION });
        const start = await awaitRoom(client);
        setStatus('Joined');
        // Guests go straight in; only the host waits in the lobby.
        finish(start);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not join that room.');
        setStatus('Not connected');
      } finally {
        busy(false);
      }
    });

    el('mp-copy').addEventListener('click', async () => {
      const code = lobbyCodeEl.textContent ?? '';
      try {
        await navigator.clipboard.writeText(code);
        setStatus('Room code copied');
      } catch {
        // Clipboard is blocked in some mobile contexts; select it instead.
        setStatus(`Room code: ${code}`);
      }
    });

    codeInput.addEventListener('input', () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
  });
}

/** In-game multiplayer overlay: player count, ping, and a Leave button. */
export class MultiplayerHud {
  private readonly root = el('mp-hud');
  private readonly countEl = el('mp-hud-count');
  private readonly pingEl = el('mp-hud-ping');
  private readonly codeEl = el('mp-hud-code');
  private readonly noticeEl = el('mp-notice');
  private noticeTimer = 0;

  constructor(onLeave: () => void) {
    el('mp-leave').addEventListener('click', onLeave);
  }

  show(code: string): void {
    this.codeEl.textContent = code;
    this.root.style.display = 'flex';
  }

  hide(): void {
    this.root.style.display = 'none';
  }

  setRoster(players: PlayerInfo[]): void {
    this.countEl.textContent = `Players: ${players.length} / ${MAX_PLAYERS}`;
  }

  setPing(ping: number | null, status: string): void {
    this.pingEl.textContent = ping === null ? status : `Ping: ${ping} ms`;
  }

  notice(message: string): void {
    this.noticeEl.textContent = message;
    this.noticeEl.style.opacity = '1';
    clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => (this.noticeEl.style.opacity = '0'), 3000);
  }
}
