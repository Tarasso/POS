import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Order } from '../models/order.models';
import {
  AnalyticsSummary,
  AnalyticsOrdersResponse,
  EventSummary,
  EventsResponse,
} from '../models/analytics.models';

@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  private http = inject(HttpClient);

  // ── Data signals ──────────────────────────────────────────────────────────
  readonly summary = signal<AnalyticsSummary | null>(null);
  readonly orders  = signal<Order[]>([]);
  readonly events  = signal<EventSummary[]>([]);
  readonly loading = signal(false);
  readonly loadingEvents = signal(false);
  readonly error   = signal<string | null>(null);

  // ── Active filter state ───────────────────────────────────────────────────
  readonly filterStartDate = signal<string>('');
  readonly filterEndDate   = signal<string>('');
  readonly filterEventName = signal<string>('');

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildParams(): HttpParams {
    let p = new HttpParams();
    if (this.filterStartDate()) p = p.set('startDate', this.filterStartDate());
    if (this.filterEndDate())   p = p.set('endDate',   this.filterEndDate());
    if (this.filterEventName()) p = p.set('eventName', this.filterEventName());
    return p;
  }

  // ── Load events list (for filter dropdown) ────────────────────────────────

  loadEvents(): void {
    this.loadingEvents.set(true);
    this.http.get<EventsResponse>('/api/analytics/events').subscribe({
      next:  r  => { this.events.set(r.events); this.loadingEvents.set(false); },
      error: () => this.loadingEvents.set(false),
    });
  }

  // ── Load summary + history with current filter ────────────────────────────

  loadAll(): void {
    this.loading.set(true);
    this.error.set(null);
    const params = this.buildParams();

    let done = 0;
    const finish = () => { if (++done === 2) this.loading.set(false); };

    this.http.get<AnalyticsSummary>('/api/analytics/summary', { params }).subscribe({
      next:  data => { this.summary.set(data); finish(); },
      error: ()   => { this.error.set('Failed to load analytics data.'); finish(); },
    });

    this.http.get<AnalyticsOrdersResponse>('/api/analytics/orders', { params }).subscribe({
      next:  res => { this.orders.set(res.orders); finish(); },
      error: ()  => { this.error.set('Failed to load order history.'); finish(); },
    });
  }

  // ── Filter helpers ────────────────────────────────────────────────────────

  applyFilter(
    startDate: string,
    endDate: string,
    eventName: string,
  ): void {
    this.filterStartDate.set(startDate);
    this.filterEndDate.set(endDate);
    this.filterEventName.set(eventName);
    this.loadAll();
  }

  clearFilter(): void {
    this.filterStartDate.set('');
    this.filterEndDate.set('');
    this.filterEventName.set('');
    this.loadAll();
  }
}
