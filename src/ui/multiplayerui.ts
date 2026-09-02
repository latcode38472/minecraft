// Mode-select and multiplayer lobby UI.
//
// showModeMenu() resolves once the player has chosen singleplayer, or has
// successfully created/joined a room — so main.ts can build the world knowing
// which seed to use. The multiplayer panel lists the worlds this browser has
// hosted or visited (open ones can be joined straight away, saved ones
// reopened by their owner), lets you make a new one, or join by code. All
// controls are pointer-event based and sized for touch, so the same UI works
// on a phone and a desktop.

import { NetClient } from '../net/client';
import { describeServer, resolveServerUrl } from '../net/config';
import { loadPlayerKey } from '../net/identity';
import {
  MAX_PLAYERS,
  NAME_MAX_LENGTH,
  PROTOCOL_VERSION,
  ROOM_CODE_LENGTH,
  WORLD_NAME_MAX_LENGTH,
  sanitizeName,
  type PlayerInfo,
  type PlayerRestoreData,
  type ServerMessage,
  type WorldInfo,
  type WorldListEntry,
} from '../net/protocol';

const NAME_STORAGE_KEY = 'voxelcraft.playerName';

export interface MultiplayerStart {
  mode: 'multiplayer';
  net: NetClient;
  code: string;
  self: PlayerInfo;
  world: WorldInfo;
  players: PlayerInfo[];
  /** Our stable player key, for rejoining after a reconnect. */
  key: string;
  /** Where we were when we last left this world, if we have been here before. */
  restore?: PlayerRestoreData;
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

function describeAge(updated: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - updated) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
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
  const worldNameInput = el<HTMLInputElement>('mp-world-name');
  const codeInput = el<HTMLInputElement>('mp-code');
  const statusEl = el('mp-status');
  const errorEl = el('mp-error');
  const lobbyEl = el('mp-lobby');
  const lobbyCodeEl = el('mp-lobby-code');
  const lobbyCountEl = el('mp-lobby-count');
  const lobbyListEl = el('mp-lobby-list');
  const serverEl = el('mp-server');
  const worldsEl = el('mp-worlds');
  const startBtn = el<HTMLButtonElement>('mp-start');
  const key = loadPlayerKey();

  nameInput.value = loadPlayerName();
  nameInput.maxLength = NAME_MAX_LENGTH;
  worldNameInput.maxLength = WORLD_NAME_MAX_LENGTH;
  codeInput.maxLength = ROOM_CODE_LENGTH;

  const serverUrl = resolveServerUrl();
  serverEl.textContent = describeServer(serverUrl);

  root.style.display = 'flex';
  panelMode.style.display = 'flex';
  panelMp.style.display = 'none';

  return new Promise<StartChoice>((resolve) => {
    let net: NetClient | null = null;
    let settled = false;
    /** Whoever is waiting for the server's answer to a create/join. */
    let pendingRoom: ((msg: ServerMessage) => void) | null = null;
    let lobbyHandler: ((msg: ServerMessage) => void) | null = null;

    const setError = (message: string): void => {
      errorEl.textContent = message;
      errorEl.style.display = message ? 'block' : 'none';
    };
    const setStatus = (message: string): void => {
      statusEl.textContent = message;
    };
    const busy = (on: boolean): void => {
      for (const id of ['mp-create', 'mp-join', 'mp-refresh']) {
        el<HTMLButtonElement>(id).disabled = on;
      }
      for (const button of worldsEl.querySelectorAll('button')) button.disabled = on;
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
      pendingRoom = null;
      lobbyHandler = null;
    };

    /** One dispatcher for the whole menu, so list, lobby and joins coexist. */
    const dispatch = (msg: ServerMessage): void => {
      if (msg.t === 'world_list') {
        renderWorlds(msg.worlds);
        return;
      }
      if (msg.t === 'room_created' || msg.t === 'join_success' || msg.t === 'join_error') {
        pendingRoom?.(msg);
        return;
      }
      lobbyHandler?.(msg);
    };

    // --- Mode panel ---
    el('mode-single').addEventListener('click', () => finish({ mode: 'singleplayer' }));
    el('mode-multi').addEventListener('click', () => {
      panelMode.style.display = 'none';
      panelMp.style.display = 'flex';
      setError('');
      setStatus('Not connected');
      void refreshWorlds();
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
      client.onMessage = dispatch;
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
          pendingRoom = null;
          rejectRoom(new Error('The server did not respond. Try again.'));
        }, 10_000);

        pendingRoom = (msg: ServerMessage) => {
          if (msg.t === 'room_created' || msg.t === 'join_success') {
            clearTimeout(timeout);
            pendingRoom = null;
            resolveRoom({
              mode: 'multiplayer',
              net: client,
              code: msg.code,
              self: msg.self,
              world: msg.world,
              players: msg.players,
              key,
              ...(msg.restore ? { restore: msg.restore } : {}),
            });
          } else if (msg.t === 'join_error') {
            clearTimeout(timeout);
            pendingRoom = null;
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
      lobbyHandler = (msg: ServerMessage) => {
        if (msg.t === 'player_joined' || msg.t === 'player_left' || msg.t === 'host_changed') {
          start.players = msg.players;
          render(msg.players);
        } else if (msg.t === 'room_closed') {
          setError(msg.message);
          lobbyEl.style.display = 'none';
        }
      };

      startBtn.onclick = () => {
        lobbyHandler = null;
        start.net.onMessage = null;
        finish(start);
      };
    };

    // --- World list ---
    const refreshWorlds = async (): Promise<void> => {
      try {
        const client = await ensureConnected();
        client.send({ t: 'list_worlds', key });
      } catch (err) {
        renderWorlds([]);
        setError(err instanceof Error ? err.message : 'Could not reach the server.');
        setStatus('Not connected');
      }
    };

    const renderWorlds = (worlds: WorldListEntry[]): void => {
      worldsEl.replaceChildren();
      if (worlds.length === 0) {
        const empty = document.createElement('p');
        empty.id = 'mp-worlds-empty';
        empty.textContent = 'No worlds yet. Create one below, or join a friend by code.';
        worldsEl.append(empty);
        return;
      }
      for (const world of worlds) {
        const row = document.createElement('div');
        row.className = 'world-row';
        const meta = document.createElement('div');
        meta.className = 'world-meta';
        const title = document.createElement('strong');
        title.textContent = world.name;
        const line = document.createElement('em');
        const status = document.createElement('span');
        status.className = `world-status ${world.status}`;
        status.textContent =
          world.status === 'open'
            ? `Open · ${world.players} / ${world.maxPlayers} playing`
            : `Saved · ${describeAge(world.updated)}`;
        line.append(`Host: ${world.host} · `, status);
        meta.append(title, line);
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = world.status === 'open' ? 'Join' : 'Open';
        button.addEventListener('click', () => void enterWorld(world));
        row.append(meta, button);
        worldsEl.append(row);
      }
    };

    const enterWorld = async (world: WorldListEntry): Promise<void> => {
      setError('');
      busy(true);
      try {
        const client = await ensureConnected();
        if (world.status === 'open' && world.code) {
          client.send({ t: 'join_room', code: world.code, name: currentName(), version: PROTOCOL_VERSION, key });
          const start = await awaitRoom(client);
          setStatus('Joined');
          if (start.self.isHost) showLobby(start);
          else finish(start);
        } else {
          client.send({ t: 'create_room', name: currentName(), version: PROTOCOL_VERSION, key, worldId: world.id });
          const start = await awaitRoom(client);
          setStatus('World opened');
          showLobby(start);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not open that world.');
        setStatus('Not connected');
      } finally {
        busy(false);
      }
    };

    el('mp-refresh').addEventListener('click', () => void refreshWorlds());

    el('mp-create').addEventListener('click', async () => {
      setError('');
      busy(true);
      try {
        const client = await ensureConnected();
        client.send({
          t: 'create_room',
          name: currentName(),
          version: PROTOCOL_VERSION,
          key,
          worldName: worldNameInput.value.trim() || undefined,
        });
        const start = await awaitRoom(client);
        setStatus('World created');
        showLobby(start);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not create the world.');
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
        client.send({ t: 'join_room', code, name: currentName(), version: PROTOCOL_VERSION, key });
        const start = await awaitRoom(client);
        setStatus('Joined');
        // Guests go straight in; only the host waits in the lobby.
        if (start.self.isHost) showLobby(start);
        else finish(start);
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
