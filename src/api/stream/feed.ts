import WebSocket, { type RawData } from 'ws';
import { authHeaderValue } from '../config.js';
import type { ConnectionStatus } from '../types.js';

export interface FeedStatus {
  status: ConnectionStatus;
  connectedAt?: string;
  disconnectedAt?: string;
  lastError?: string;
  reconnectCount?: number;
}

export interface ResilientFeedOptions {
  name: string;
  url: string;
  token: string;
  /** Runs before buffered messages are released, making replay + live handoff lossless. */
  beforeReady?: () => Promise<void>;
  onReady?: () => void;
  onMessage: (message: unknown) => Promise<void> | void;
  onMalformed: (raw: string) => void;
  onStatus: (status: FeedStatus) => void;
}

/**
 * Small raw-WebSocket supervisor. It deliberately owns no domain state: the
 * daemon supplies reducers, so stream transport can be tested independently.
 */
export class ResilientFeed {
  private socket: WebSocket | null = null;
  private active = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private lastPong = 0;
  private reconnectCount = 0;
  private initializing = false;
  private buffered: string[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(protected readonly options: ResilientFeedOptions) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.connect();
  }

  stop(): void {
    this.active = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearPing();
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
    this.options.onStatus({ status: 'closed', disconnectedAt: new Date().toISOString(), reconnectCount: this.reconnectCount });
  }

  protected send(value: unknown): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(value));
    return true;
  }

  private connect(): void {
    if (!this.active) return;
    this.options.onStatus({ status: this.reconnectCount ? 'reconnecting' : 'connecting', reconnectCount: this.reconnectCount });
    const socket = new WebSocket(this.options.url, { headers: { Authorization: authHeaderValue(this.options.token) } });
    this.socket = socket;

    socket.on('open', () => void this.handleOpen(socket));
    socket.on('message', raw => this.handleRaw(raw));
    socket.on('pong', () => { this.lastPong = Date.now(); });
    socket.on('error', error => {
      this.options.onStatus({ status: 'error', lastError: error.message, reconnectCount: this.reconnectCount });
    });
    socket.on('close', () => this.handleClose(socket));
  }

  private async handleOpen(socket: WebSocket): Promise<void> {
    if (!this.active || socket !== this.socket) return;
    this.lastPong = Date.now();
    this.startPing(socket);
    this.initializing = true;
    try {
      await this.options.beforeReady?.();
      this.options.onReady?.();
      this.initializing = false;
      for (const raw of this.buffered.splice(0)) this.enqueue(raw);
      this.options.onStatus({ status: 'live', connectedAt: new Date().toISOString(), reconnectCount: this.reconnectCount });
      this.reconnectCount = 0;
    } catch (error) {
      this.options.onStatus({ status: 'error', lastError: error instanceof Error ? error.message : String(error), reconnectCount: this.reconnectCount });
      socket.terminate();
    }
  }

  private handleRaw(raw: RawData): void {
    const text = raw.toString();
    if (this.initializing) {
      this.buffered.push(text);
      return;
    }
    this.enqueue(text);
  }

  private enqueue(raw: string): void {
    this.queue = this.queue.then(async () => {
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        this.options.onMalformed(raw);
        return;
      }
      await this.options.onMessage(message);
    }).catch(error => {
      this.options.onStatus({ status: 'error', lastError: error instanceof Error ? error.message : String(error), reconnectCount: this.reconnectCount });
    });
  }

  private handleClose(socket: WebSocket): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.clearPing();
    if (!this.active) return;
    this.reconnectCount++;
    this.options.onStatus({ status: 'reconnecting', disconnectedAt: new Date().toISOString(), reconnectCount: this.reconnectCount });
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(this.reconnectCount - 1, 5));
    this.reconnectTimer = setTimeout(() => this.connect(), delay + Math.floor(Math.random() * 250));
    this.reconnectTimer.unref?.();
  }

  private startPing(socket: WebSocket): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
      if (Date.now() - this.lastPong > 30_000) socket.terminate();
    }, 10_000);
    this.pingTimer.unref?.();
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
