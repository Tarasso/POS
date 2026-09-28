import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import * as signalR from '@microsoft/signalr';
import { Order } from '../models/order.models';
import { GuestTokenHttpClient } from './signalr-http-client';

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

  /**
   * IDs completed recently (by this or any other device). A GET /api/orders
   * response that was already in flight when the completion happened would
   * otherwise re-add a finished order as a ghost card.
   */
  private readonly recentlyCompleted = new Set<string>();

  private markCompleted(orderId: string): void {
    this.recentlyCompleted.add(orderId);
    if (this.recentlyCompleted.size > 500) {
      // Sets iterate in insertion order — drop the oldest.
      this.recentlyCompleted.delete(this.recentlyCompleted.values().next().value!);
    }
    this.orders.update(list => list.filter(o => o.id !== orderId));
  }

  // ── Initial data load ──────────────────────────────────────────────────────

  /**
   * Fetch currently open orders from the API.
   * Call once on KDS page init so orders placed before the page opened appear.
   */
  loadOrders(): void {
    this.http.get<{ orders: Order[] }>('/api/orders?status=open').subscribe({
      next: (data) => {
        // Sort oldest-first so top-left card is the most urgent.
        const sorted = data.orders
          .filter(o => !this.recentlyCompleted.has(o.id))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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

    // GuestTokenHttpClient: SignalR bypasses Angular's interceptors.
    this.hubConnection = new signalR.HubConnectionBuilder()
      .withUrl('/api', { httpClient: new GuestTokenHttpClient() })
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    // ── Event handlers ───────────────────────────────────────────────────────
    this.hubConnection.on('orderCreated', (order: Order) => {
      // New orders go to the end (oldest-first sort means newest is last).
      // Skip if the initial HTTP load already included it (the two race on page open).
      this.orders.update(list =>
        list.some(o => o.id === order.id) || this.recentlyCompleted.has(order.id)
          ? list
          : [...list, order]
      );
    });

    this.hubConnection.on('orderCompleted', ({ orderId }: { orderId: string }) => {
      // Idempotent: if the KDS itself already removed the order on HTTP success,
      // this filter is a no-op.
      this.markCompleted(orderId);
    });

    this.hubConnection.onreconnecting(() => {
      this.connectionState.set('connecting');
    });

    this.hubConnection.onreconnected(() => {
      this.connectionState.set('connected');
      // Events broadcast while the socket was down are lost — resync.
      this.loadOrders();
    });

    this.hubConnection.onclose(() => {
      this.connectionState.set('disconnected');
    });

    // ── Start connection ─────────────────────────────────────────────────────
    this.connectionState.set('connecting');
    this.hubConnection.start()
      .then(() => {
        this.connectionState.set('connected');
        // Orders placed between the initial HTTP load and the socket opening
        // were broadcast before we were listening — resync now that we are.
        this.loadOrders();
      })
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

  // ── Completed orders history ───────────────────────────────────────────────

  /** Completed orders, newest-first. Loaded on demand when the history panel is opened. */
  readonly completedOrders = signal<Order[]>([]);
  readonly loadingCompleted = signal(false);
  readonly completedError = signal<string | null>(null);

  /** Fetch completed orders sorted newest-first. */
  loadCompletedOrders(): void {
    this.loadingCompleted.set(true);
    this.completedError.set(null);
    this.http.get<{ orders: Order[] }>('/api/orders?status=completed').subscribe({
      next: (data) => {
        const sorted = [...data.orders].sort((a, b) =>
          (b.completedAt ?? b.createdAt).localeCompare(a.completedAt ?? a.createdAt)
        );
        this.completedOrders.set(sorted);
        this.loadingCompleted.set(false);
      },
      error: (err) => {
        console.error('KdsService: failed to load completed orders', err);
        this.completedError.set('Failed to load completed orders.');
        this.loadingCompleted.set(false);
      },
    });
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
        // (Also the path when another device completed it first — the API
        // answers 200 with alreadyCompleted: true.)
        this.markCompleted(orderId);
        this.completing.update(s => {
          const next = new Set(s);
          next.delete(orderId);
          return next;
        });
      },
      error: (err) => {
        console.error(`KdsService: failed to complete order ${orderId}`, err);
        // 404: the order no longer exists at all — drop the stale card.
        if (err?.status === 404) this.markCompleted(orderId);
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
