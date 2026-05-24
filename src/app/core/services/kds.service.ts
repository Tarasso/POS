import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import * as signalR from '@microsoft/signalr';
import { Order } from '../models/order.models';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

@Injectable({ providedIn: 'root' })
export class KdsService {
  private http = inject(HttpClient);
  private hubConnection: signalR.HubConnection | null = null;

  // ── State signals ──────────────────────────────────────────────────────────
  /** Open orders sorted oldest-first (top-left = most urgent). */
  readonly orders = signal<Order[]>([]);

  /** SignalR connection lifecycle state. */
  readonly connectionState = signal<ConnectionState>('disconnected');

  /** Set of order IDs currently being completed (button loading state). */
  readonly completing = signal<Set<string>>(new Set<string>());

  /** Non-null when the initial GET /api/orders fetch failed. */
  readonly loadError = signal<string | null>(null);

  // ── Initial data load ──────────────────────────────────────────────────────

  /**
   * Fetch currently open orders from the API.
   * Call once on KDS page init so orders placed before the page opened appear.
   */
  loadOrders(): void {
    this.http.get<{ orders: Order[] }>('/api/orders?status=open').subscribe({
      next: (data) => {
        // Sort oldest-first so top-left card is the most urgent.
        const sorted = [...data.orders].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt)
        );
        this.orders.set(sorted);
        this.loadError.set(null);
      },
      error: (err) => {
        console.error('KdsService: failed to load orders', err);
        this.loadError.set('Failed to load orders. Refresh to try again.');
      },
    });
  }

  // ── SignalR connection ─────────────────────────────────────────────────────

  /**
   * Connect to Azure SignalR via the negotiate endpoint.
   * @microsoft/signalr HubConnectionBuilder appends "/negotiate" to the base
   * URL, so "/api" → POST /api/negotiate → Azure SignalR WebSocket.
   */
  connect(): void {
    if (this.hubConnection) return; // already connected or connecting

    this.hubConnection = new signalR.HubConnectionBuilder()
      .withUrl('/api')
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    // ── Event handlers ───────────────────────────────────────────────────────
    this.hubConnection.on('orderCreated', (order: Order) => {
      // New orders go to the end (oldest-first sort means newest is last).
      this.orders.update(list => [...list, order]);
    });

    this.hubConnection.on('orderCompleted', ({ orderId }: { orderId: string }) => {
      // Idempotent: if the KDS itself already removed the order on HTTP success,
      // this filter is a no-op.
      this.orders.update(list => list.filter(o => o.id !== orderId));
    });

    this.hubConnection.onreconnecting(() => {
      this.connectionState.set('connecting');
    });

    this.hubConnection.onreconnected(() => {
      this.connectionState.set('connected');
    });

    this.hubConnection.onclose(() => {
      this.connectionState.set('disconnected');
    });

    // ── Start connection ─────────────────────────────────────────────────────
    this.connectionState.set('connecting');
    this.hubConnection.start()
      .then(() => this.connectionState.set('connected'))
      .catch((err) => {
        console.error('KdsService: SignalR connection failed', err);
        this.connectionState.set('error');
      });
  }

  /** Disconnect from SignalR. Call from ngOnDestroy. */
  disconnect(): void {
    this.hubConnection?.stop();
    this.hubConnection = null;
    this.connectionState.set('disconnected');
  }

  // ── Complete action ────────────────────────────────────────────────────────

  /**
   * Mark an order as completed via the API.
   *
   * On HTTP success: removes the order from the `orders` signal immediately
   * (the SignalR `orderCompleted` event will also arrive and be a no-op).
   * On error: re-enables the Done button so the user can retry.
   */
  completeOrder(orderId: string): void {
    // Track in-flight to disable the button.
    this.completing.update(s => new Set([...s, orderId]));

    this.http.patch(`/api/orders/${orderId}/complete`, {}).subscribe({
      next: () => {
        // Remove order immediately — don't wait for SignalR round-trip.
        this.orders.update(list => list.filter(o => o.id !== orderId));
        this.completing.update(s => {
          const next = new Set(s);
          next.delete(orderId);
          return next;
        });
      },
      error: (err) => {
        console.error(`KdsService: failed to complete order ${orderId}`, err);
        // Re-enable the button so the user can retry.
        this.completing.update(s => {
          const next = new Set(s);
          next.delete(orderId);
          return next;
        });
      },
    });
  }
}
