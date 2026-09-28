import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { RouterLink } from '@angular/router';
import { CounterService } from '../../core/services/counter.service';
import { AuthService } from '../../core/services/auth.service';
import { onPullRefresh } from '../../core/services/pull-refresh.service';

/**
 * Ticket Counter — each station taps a drink's card when it redeems a prepaid
 * drink ticket. Big targets; the − button undoes a mis-tap.
 */
@Component({
  selector: 'app-counter',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './counter.html',
  styleUrl: './counter.scss',
})
export class Counter implements OnInit, OnDestroy {
  private readonly svc = inject(CounterService);
  private readonly doc = inject(DOCUMENT);
  readonly hasFullAccess = inject(AuthService).hasFullAccess;

  readonly event = this.svc.event;
  readonly station = this.svc.station;
  readonly stations = this.svc.stations;
  readonly loaded = this.svc.loaded;
  readonly error = this.svc.error;
  readonly connection = this.svc.connection;
  readonly grandTotal = this.svc.grandTotal;

  /** itemId → tap nonce; re-creates the "+1" bubble so its animation replays. */
  readonly flash = signal<Record<string, number>>({});
  private errorTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    onPullRefresh(() => this.svc.load());
  }

  ngOnInit(): void {
    void this.svc.load();
    this.svc.connect();
    this.doc.addEventListener('visibilitychange', this.onVisible);
  }

  ngOnDestroy(): void {
    this.doc.removeEventListener('visibilitychange', this.onVisible);
    this.svc.disconnect();
    if (this.errorTimer) clearTimeout(this.errorTimer);
  }

  /** Back from the background: the socket may have died silently (iOS). */
  private readonly onVisible = (): void => {
    if (this.doc.visibilityState !== 'visible') return;
    const c = this.connection();
    if (c === 'disconnected' || c === 'error') {
      this.svc.disconnect();
      this.svc.connect();
    } else {
      void this.svc.load();
    }
  };

  count(station: number, itemId: string): number { return this.svc.count(station, itemId); }
  itemTotal(itemId: string): number { return this.svc.itemTotal(itemId); }
  stationTotal(station: number): number { return this.svc.stationTotal(station); }

  selectStation(n: number): void { this.svc.selectStation(n); }

  increment(itemId: string): void {
    if (!this.station()) return;
    this.svc.tap(itemId, 1);
    this.flash.update(f => ({ ...f, [itemId]: (f[itemId] ?? 0) + 1 }));
    this.autoClearError();
  }

  decrement(itemId: string, e: Event): void {
    e.stopPropagation(); // don't also count the card tap
    this.svc.tap(itemId, -1);
    this.autoClearError();
  }

  flashKey(itemId: string): number { return this.flash()[itemId] ?? 0; }

  private autoClearError(): void {
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => this.svc.clearError(), 5_000);
  }
}
