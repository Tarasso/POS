import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { KdsService } from '../../core/services/kds.service';

@Component({
  selector: 'app-kds',
  standalone: true,
  imports: [],
  templateUrl: './kds.html',
  styleUrl: './kds.scss',
})
export class Kds implements OnInit, OnDestroy {
  private kdsService = inject(KdsService);
  private doc = inject(DOCUMENT);

  // ── Expose service state to template ──────────────────────────────────────
  readonly orders = this.kdsService.orders;
  readonly connectionState = this.kdsService.connectionState;
  readonly completing = this.kdsService.completing;
  readonly loadError = this.kdsService.loadError;

  // ── 1-second tick to drive live timers ───────────────────────────────────
  private readonly tick = signal(0);
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  ngOnInit(): void {
    // Swap manifest so "Add to Home Screen" on iPad captures /kds as start URL.
    const link = this.doc.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (link) link.href = '/manifest-kds.webmanifest';

    this.kdsService.loadOrders();
    this.kdsService.connect();
    // Tick every second; templates call elapsedDisplay/urgencyClass which read
    // this.tick(), registering a dependency so Angular re-renders each tick.
    this.tickInterval = setInterval(() => this.tick.update(n => n + 1), 1_000);
  }

  ngOnDestroy(): void {
    // Restore default manifest when navigating away from the KDS route.
    const link = this.doc.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (link) link.href = '/manifest.webmanifest';

    this.kdsService.disconnect();
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  completeOrder(orderId: string): void {
    this.kdsService.completeOrder(orderId);
  }

  /** Manually reconnect after a permanent SignalR failure. */
  reconnect(): void {
    this.kdsService.disconnect(); // nulls the hub connection reference
    this.kdsService.connect();    // starts a fresh connection
  }

  // ── Timer helpers ─────────────────────────────────────────────────────────

  /**
   * Returns elapsed time as "Xm Ys" (e.g. "3m 42s") or just "Ys" under 1 min.
   * Reads this.tick() so Angular re-renders this expression every second.
   */
  elapsedDisplay(createdAt: string): string {
    this.tick(); // subscribe to 1-second tick
    const totalSec = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1_000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  /**
   * Returns a CSS class string for urgency color coding:
   *   '' (normal) → < 8 minutes
   *   'urgent-yellow' → 8–14 minutes
   *   'urgent-red'    → ≥ 15 minutes
   */
  urgencyClass(createdAt: string): string {
    this.tick(); // subscribe to 1-second tick so urgency updates live
    const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000);
    if (mins >= 15) return 'urgent-red';
    if (mins >= 8) return 'urgent-yellow';
    return '';
  }
}
