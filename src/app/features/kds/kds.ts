import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { DOCUMENT, DatePipe } from '@angular/common';
import { KdsService } from '../../core/services/kds.service';

@Component({
  selector: 'app-kds',
  standalone: true,
  imports: [DatePipe],
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

  // ── Completed history panel ────────────────────────────────────────────────
  readonly showCompleted = signal(false);
  readonly completedOrders = this.kdsService.completedOrders;
  readonly loadingCompleted = this.kdsService.loadingCompleted;
  readonly completedError = this.kdsService.completedError;

  // ── First-tap visual feedback for double-tap-to-complete ──────────────────
  /** Set of order IDs that have received a first tap (shows "Tap again!" hint). */
  readonly firstTapped = signal<Set<string>>(new Set<string>());
  private firstTapTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    this.tickInterval = setInterval(() => this.tick.update(n => n + 1), 1_000);
  }

  ngOnDestroy(): void {
    const link = this.doc.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    if (link) link.href = '/manifest.webmanifest';

    this.kdsService.disconnect();
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    // Clean up any pending first-tap timers.
    this.firstTapTimers.forEach(t => clearTimeout(t));
    this.firstTapTimers.clear();
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  completeOrder(orderId: string): void {
    this.kdsService.completeOrder(orderId);
  }

  /** Manually reconnect after a permanent SignalR failure. */
  reconnect(): void {
    this.kdsService.disconnect();
    this.kdsService.connect();
  }

  // ── Completed history panel ────────────────────────────────────────────────

  openCompleted(): void {
    this.showCompleted.set(true);
    this.kdsService.loadCompletedOrders();
  }

  closeCompleted(): void {
    this.showCompleted.set(false);
  }

  refreshCompleted(): void {
    this.kdsService.loadCompletedOrders();
  }

  // ── Double-tap / double-click to complete ─────────────────────────────────

  /**
   * Fires on touchstart of the card. Records the first tap so we can show the
   * "Tap again!" hint. CSS `touch-action: manipulation` on the card ensures
   * the browser fires dblclick quickly (without the 300 ms zoom-detection delay)
   * on the second tap, which is where the actual completion happens.
   */
  onCardTouchStart(orderId: string): void {
    if (this.completing().has(orderId) || this.firstTapped().has(orderId)) return;
    // Mark first tap and auto-clear after 450 ms if no second tap follows.
    this.firstTapped.update(s => new Set([...s, orderId]));
    const timer = setTimeout(() => {
      this.firstTapped.update(s => { const n = new Set(s); n.delete(orderId); return n; });
      this.firstTapTimers.delete(orderId);
    }, 450);
    this.firstTapTimers.set(orderId, timer);
  }

  /**
   * Fires on dblclick (desktop) and on a double-tap (iOS/iPad, thanks to
   * `touch-action: manipulation` which eliminates the 300 ms delay).
   */
  onCardDblClick(orderId: string): void {
    // Clear the first-tap hint state.
    const timer = this.firstTapTimers.get(orderId);
    if (timer) { clearTimeout(timer); this.firstTapTimers.delete(orderId); }
    this.firstTapped.update(s => { const n = new Set(s); n.delete(orderId); return n; });

    if (!this.completing().has(orderId)) {
      this.completeOrder(orderId);
    }
  }

  // ── Modifier pill helpers ──────────────────────────────────────────────────

  /**
   * Returns the text color to use over a given hex background so pills are
   * always legible on the KDS.  Dark text for light backgrounds, white for dark.
   */
  modPillTextColor(bgHex: string): string {
    const r = parseInt(bgHex.slice(1, 3), 16);
    const g = parseInt(bgHex.slice(3, 5), 16);
    const b = parseInt(bgHex.slice(5, 7), 16);
    // Perceived luminance (ITU-R BT.601 coefficients)
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? '#1a1a1a' : '#ffffff';
  }

  // ── Timer helpers ─────────────────────────────────────────────────────────

  /**
   * Returns elapsed time as "Xm Ys" or just "Ys" under 1 min.
   * Reads this.tick() so Angular re-renders every second.
   */
  elapsedDisplay(createdAt: string): string {
    this.tick();
    const totalSec = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1_000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  /**
   * Returns a CSS class string for urgency colour coding:
   *   '' (normal)      → < 8 minutes
   *   'urgent-yellow'  → 8–14 minutes
   *   'urgent-red'     → ≥ 15 minutes
   */
  urgencyClass(createdAt: string): string {
    this.tick();
    const mins = Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000);
    if (mins >= 15) return 'urgent-red';
    if (mins >= 8) return 'urgent-yellow';
    return '';
  }
}
