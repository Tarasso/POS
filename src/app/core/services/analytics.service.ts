import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Order } from '../models/order.models';
import { AnalyticsSummary, AnalyticsOrdersResponse } from '../models/analytics.models';

@Injectable({ providedIn: 'root' })
export class AnalyticsService {
  private http = inject(HttpClient);

  summary = signal<AnalyticsSummary | null>(null);
  orders = signal<Order[]>([]);
  loading = signal(false);
  error = signal<string | null>(null);

  loadSummary(): void {
    this.http.get<AnalyticsSummary>('/api/analytics/summary').subscribe({
      next: (data) => this.summary.set(data),
      error: () => this.error.set('Failed to load analytics summary.'),
    });
  }

  loadOrders(): void {
    this.http.get<AnalyticsOrdersResponse>('/api/analytics/orders').subscribe({
      next: (res) => this.orders.set(res.orders),
      error: () => this.error.set('Failed to load order history.'),
    });
  }

  loadAll(): void {
    this.loading.set(true);
    this.error.set(null);

    let done = 0;
    const finish = () => {
      done++;
      if (done === 2) this.loading.set(false);
    };

    this.http.get<AnalyticsSummary>('/api/analytics/summary').subscribe({
      next: (data) => { this.summary.set(data); finish(); },
      error: () => { this.error.set('Failed to load analytics data.'); finish(); },
    });

    this.http.get<AnalyticsOrdersResponse>('/api/analytics/orders').subscribe({
      next: (res) => { this.orders.set(res.orders); finish(); },
      error: () => { this.error.set('Failed to load order history.'); finish(); },
    });
  }
}
