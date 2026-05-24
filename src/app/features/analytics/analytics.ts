import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AnalyticsService } from '../../core/services/analytics.service';
import { ModifierGroupStat } from '../../core/models/analytics.models';
import { Order } from '../../core/models/order.models';

type FilterMode = 'event' | 'daterange';

@Component({
  selector: 'app-analytics',
  standalone: true,
  imports: [DatePipe, DecimalPipe, FormsModule],
  templateUrl: './analytics.html',
  styleUrl: './analytics.scss',
})
export class Analytics implements OnInit {
  protected svc = inject(AnalyticsService);

  // ── Expose service signals to template ───────────────────────────────────
  readonly summary       = this.svc.summary;
  readonly orders        = this.svc.orders;
  readonly events        = this.svc.events;
  readonly loading       = this.svc.loading;
  readonly loadingEvents = this.svc.loadingEvents;
  readonly error         = this.svc.error;

  // ── Filter UI state ───────────────────────────────────────────────────────
  readonly filterMode = signal<FilterMode>('event');

  // Draft values (applied on "Apply" button press or event tap)
  readonly draftStart = signal('');
  readonly draftEnd   = signal('');

  // ngModel bridge for date inputs (signals can't two-way bind directly)
  get startDate(): string { return this.draftStart(); }
  set startDate(v: string) { this.draftStart.set(v); }

  get endDate(): string { return this.draftEnd(); }
  set endDate(v: string) { this.draftEnd.set(v); }

  // Derived: are any filters currently active?
  readonly hasFilter = computed(() =>
    !!(this.svc.filterStartDate() || this.svc.filterEndDate() || this.svc.filterEventName())
  );

  readonly activeFilterLabel = computed(() => {
    if (this.svc.filterEventName()) return `Event: ${this.svc.filterEventName()}`;
    const s = this.svc.filterStartDate();
    const e = this.svc.filterEndDate();
    if (s && e && s === e) return `Date: ${s}`;
    if (s && e) return `${s} → ${e}`;
    if (s) return `From ${s}`;
    if (e) return `Until ${e}`;
    return '';
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  ngOnInit(): void {
    this.svc.loadEvents();
    this.svc.loadAll();  // default: all-time, no filter
  }

  // ── Filter mode toggle ────────────────────────────────────────────────────
  setFilterMode(mode: FilterMode): void {
    this.filterMode.set(mode);
  }

  // ── Event-based filter ────────────────────────────────────────────────────
  selectEvent(name: string): void {
    this.svc.applyFilter('', '', name);
  }

  // ── Date preset helpers ───────────────────────────────────────────────────
  private todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  setPreset(preset: 'today' | 'yesterday' | 'month'): void {
    const today = new Date();
    let start: string;
    let end: string;

    if (preset === 'today') {
      start = end = this.todayStr();
    } else if (preset === 'yesterday') {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      start = end = y.toISOString().slice(0, 10);
    } else {
      // This calendar month
      start = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
      end = this.todayStr();
    }

    this.draftStart.set(start);
    this.draftEnd.set(end);
    this.svc.applyFilter(start, end, '');
  }

  applyDateRange(): void {
    this.svc.applyFilter(this.draftStart(), this.draftEnd(), '');
  }

  clearFilter(): void {
    this.draftStart.set('');
    this.draftEnd.set('');
    this.svc.clearFilter();
  }

  // ── Modifier bar chart helper ─────────────────────────────────────────────
  /** Returns the max count across all options in a group (for bar width calc). */
  maxCount(group: ModifierGroupStat): number {
    return group.options.reduce((m, o) => Math.max(m, o.count), 1);
  }

  barWidth(count: number, group: ModifierGroupStat): string {
    return `${Math.round((count / this.maxCount(group)) * 100)}%`;
  }

  /** Total items served in one order (sum of all line item qtys). */
  orderItemCount(order: Order): number {
    return order.items.reduce((sum, i) => sum + i.qty, 0);
  }
}
