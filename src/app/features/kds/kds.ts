import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { DOCUMENT, DatePipe } from '@angular/common';
import { KdsService } from '../../core/services/kds.service';
import { AppliedModifier } from '../../core/models/order.models';

/** One row in the grouped modifier display — all options from one modifier group. */
export interface ModGroupRow {
  groupId: string;
  groupName: string;
  mods: AppliedModifier[];
}

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

  // Timestamp of the last click per order — used for manual double-tap detection.
  // More reliable than (dblclick) on iPhone where the browser hit-test for
  // synthesising dblclick from two quick taps is stricter than on iPad/desktop.
  private lastClickTime = new Map<string, number>();
  private readonly DOUBLE_TAP_MS = 400;

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
    // Clean up any pending first-tap timers and click-time tracking.
    this.firstTapTimers.forEach(t => clearTimeout(t));
    this.firstTapTimers.clear();
    this.lastClickTime.clear();
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
   * Unified handler for both mouse clicks (desktop) and touch taps (mobile).
   *
   * Why (click) instead of (touchstart)+(dblclick):
   *   `dblclick` synthesis from touch works reliably on iPad and desktop but is
   *   flaky on iPhone — iOS requires both taps to land on the *exact same DOM
   *   element*, which fails when sub-elements (qty badge, pill chip, etc.) absorb
   *   the touch.  Using (click) with manual timestamp tracking is cross-device
   *   reliable.  `touch-action: manipulation` on the card (set in the SCSS) still
   *   removes the 300 ms delay so the click fires instantly on the first tap.
   *
   * Flow:
   *   First tap  → record timestamp, show "Tap again!" hint for DOUBLE_TAP_MS.
   *   Second tap within DOUBLE_TAP_MS → clear hint, call completeOrder().
   *   No second tap → hint auto-clears when the timer fires.
   */
  onCardClick(orderId: string): void {
    const now = Date.now();
    const last = this.lastClickTime.get(orderId) ?? 0;

    if (last > 0 && now - last < this.DOUBLE_TAP_MS) {
      // ── Second tap: complete the order ──────────────────────────────────
      this.lastClickTime.delete(orderId);
      const timer = this.firstTapTimers.get(orderId);
      if (timer) { clearTimeout(timer); this.firstTapTimers.delete(orderId); }
      this.firstTapped.update(s => { const n = new Set(s); n.delete(orderId); return n; });
      if (!this.completing().has(orderId)) {
        this.completeOrder(orderId);
      }
    } else {
      // ── First tap: show "Tap again!" hint ───────────────────────────────
      this.lastClickTime.set(orderId, now);
      if (this.completing().has(orderId) || this.firstTapped().has(orderId)) return;
      this.firstTapped.update(s => new Set([...s, orderId]));
      const timer = setTimeout(() => {
        this.firstTapped.update(s => { const n = new Set(s); n.delete(orderId); return n; });
        this.firstTapTimers.delete(orderId);
        this.lastClickTime.delete(orderId);
      }, this.DOUBLE_TAP_MS);
      this.firstTapTimers.set(orderId, timer);
    }
  }

  // ── Modifier grouping ─────────────────────────────────────────────────────

  /**
   * Groups a flat AppliedModifier array by modifier group, preserving the order
   * the groups appear in (which matches the group sortOrder set at order time).
   * Each group becomes one row of pills on the KDS card.
   *
   * Works for any number of groups/options — scales automatically.
   */
  modsByGroup(modifiers: AppliedModifier[]): ModGroupRow[] {
    const seen: string[] = [];
    const map = new Map<string, ModGroupRow>();
    for (const mod of modifiers) {
      if (!map.has(mod.groupId)) {
        seen.push(mod.groupId);
        map.set(mod.groupId, { groupId: mod.groupId, groupName: mod.groupName, mods: [] });
      }
      map.get(mod.groupId)!.mods.push(mod);
    }
    return seen.map(id => map.get(id)!);
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
