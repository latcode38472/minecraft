// WebSocket transport: connection lifecycle, ping/RTT, and typed dispatch.
//
// Deliberately knows nothing about Three.js, the world, or the DOM — it turns
// a socket into typed events and sends typed messages. Game wiring lives in
// session.ts, UI in ui/multiplayerui.ts.

import {
  PING_INTERVAL_MS,
  decodeMessage,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from './protocol';

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'error';

type Handler = (msg: ServerMessage) => void;

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

export class NetClient {
  status: ConnectionStatus = 'idle';
  /** Smoothed round-trip time in ms, or null before the first pong. */
  ping: number | null = null;

  onMessage: Handler | null = null;
  onStatusChange: ((status: ConnectionStatus) => void) | null = null;

  private socket: WebSocket | null = null;
  private pingTimer = 0;
  private reconnectTimer = 0;
  private reconnectAttempt = 0;
  /** Set once the room ends; stops the reconnect loop from resurrecting it. */
  private finished = false;

  constructor(readonly url: string) {}

  connect(): Promise<void> {
    this.finished = false;
    return new Promise((resolve, reject) => {
      this.setStatus(this.reconnectAttempt > 0 ? 'reconnecting' : 'connecting');
      let socket: WebSocket;
      try {
        socket = new WebSocket(this.url);
      } catch (err) {
        this.setStatus('error');
        reject(err instanceof Error ? err : new Error('Could not open a connection'));
        return;
      }
      this.socket = socket;
      let settled = false;

      socket.onopen = () => {
        this.reconnectAttempt = 0;
        this.setStatus('connected');
        this.startPing();
        settled = true;
        resolve();
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        const parsed = decodeMessage(event.data);
        if (!parsed) return;
        const msg = parsed as unknown as ServerMessage;
        if (msg.t === 'pong') {
          this.recordPong(msg.time);
          return;
        }
        this.onMessage?.(msg);
      };

      socket.onerror = () => {
        if (!settled) {
          settled = true;
          this.setStatus('error');
          reject(new Error('Could not reach the multiplayer server'));
        }
      };

      socket.onclose = () => {
        this.stopPing();
        this.socket = null;
        if (this.finished) {
          this.setStatus('closed');
          return;
        }
        if (settled) this.scheduleReconnect();
      };
    });
  }

  send(msg: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(encodeMessage(msg));
  }

  /** Close for good: no reconnect attempts after this. */
  close(): void {
    this.finished = true;
    this.stopPing();
    clearTimeout(this.reconnectTimer);
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.send({ t: 'leave_room' });
    }
    this.socket?.close();
    this.socket = null;
    this.setStatus('closed');
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatusChange?.(status);
  }

  private startPing(): void {
    this.stopPing();
    const tick = (): void => {
      this.send({ t: 'ping', time: Date.now() });
    };
    tick();
    this.pingTimer = window.setInterval(tick, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = 0;
  }

  private recordPong(sentAt: number): void {
    const rtt = Date.now() - sentAt;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 60_000) return;
    // Exponential smoothing keeps the readout from flickering on jitter.
    this.ping = this.ping === null ? rtt : Math.round(this.ping * 0.7 + rtt * 0.3);
  }

  /**
   * Backoff reconnect. The room is not rejoined automatically — the session
   * decides that, because rejoining needs the room code and player name.
   */
  private scheduleReconnect(): void {
    if (this.finished) return;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;
    this.setStatus('reconnecting');
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      this.connect().catch(() => {
        /* onclose schedules the next attempt */
      });
    }, delay);
  }
}
