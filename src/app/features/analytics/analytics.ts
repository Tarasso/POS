import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AnalyticsService } from '../../core/services/analytics.service';
import { onPullRefresh } from '../../core/services/pull-refresh.service';
import { CounterService } from '../../core/services/counter.service';
import { CounterEvent, CounterSnapshot } from '../../core/models/counter.models';
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

  // ── Ticket Counter results ────────────────────────────────────────────────
  private counterSvc = inject(CounterService);
  readonly view = signal<'orders' | 'counter'>('orders');
  readonly counterEvents = signal<CounterEvent[]>([]);
  readonly counterEventsLoading = signal(false);
  readonly selectedCounterId = signal<string | null>(null);
  readonly counterResults = signal<CounterSnapshot | null>(null);
  readonly counterResultsLoading = signal(false);
  readonly counterError = signal<string | null>(null);

  /** Drinks × stations table for the selected counter event. */
  readonly counterReport = computed(() => {
    const snap = this.counterResults();
    const ev = snap?.event;
    if (!snap || !ev) return null;
    const stations = Array.from({ length: ev.stationCount }, (_, i) => i + 1);
    const byItem = new Map<string, { name: string; counts: number[] }>();
    // Current drinks first, in the owner's order…
    for (const item of ev.items) byItem.set(item.id, { name: item.name, counts: stations.map(() => 0) });
    // …then any tallies for drinks removed since (name kept on the tally).
    const liveIds = new Set(ev.items.map(i => i.id));
    for (const t of snap.tallies) {
      if (!byItem.has(t.itemId)) byItem.set(t.itemId, { name: t.itemName, counts: stations.map(() => 0) });
      const row = byItem.get(t.itemId)!;
      if (t.station >= 1 && t.station <= stations.length) row.counts[t.station - 1] += t.count;
    }
    const rows = [...byItem.entries()]
      .map(([itemId, r]) => ({
        itemId, name: r.name, byStation: r.counts,
        total: r.counts.reduce((a, b) => a + b, 0),
        removed: !liveIds.has(itemId),
      }))
      .filter(r => !r.removed || r.total > 0);
    const stationTotals = stations.map((_, i) => rows.reduce((sum, r) => sum + r.byStation[i], 0));
    return {
      name: ev.name, createdAt: ev.createdAt, stations, rows, stationTotals,
      total: stationTotals.reduce((a, b) => a + b, 0),
    };
  });

  constructor() {
    // Pull-to-refresh re-runs the current filter / reloads the counter view.
    onPullRefresh(() => {
      if (this.view() === 'counter') {
        this.loadCounterEvents();
        const id = this.selectedCounterId();
        if (id) this.selectCounterEvent(id);
      } else {
        this.svc.loadEvents();
        this.svc.loadAll();
      }
    });
  }

  setView(view: 'orders' | 'counter'): void {
    this.view.set(view);
    if (view === 'counter' && this.counterEvents().length === 0) this.loadCounterEvents(true);
  }

  private loadCounterEvents(selectFirst = false): void {
    this.counterEventsLoading.set(true);
    this.counterSvc.listEvents().subscribe({
      next: (res) => {
        this.counterEvents.set(res.events);
        this.counterEventsLoading.set(false);
        // Open the active (or newest) event straight away.
        if (selectFirst && !this.selectedCounterId() && res.events.length) {
          this.selectCounterEvent((res.events.find(e => e.active) ?? res.events[0]).id);
        }
      },
      error: () => {
        this.counterEventsLoading.set(false);
        this.counterError.set('Failed to load counter events.');
      },
    });
  }

  selectCounterEvent(id: string): void {
    this.selectedCounterId.set(id);
    this.counterResultsLoading.set(true);
    this.counterError.set(null);
    this.counterSvc.results(id).subscribe({
      next: (snap) => { this.counterResults.set(snap); this.counterResultsLoading.set(false); },
      error: () => { this.counterResultsLoading.set(false); this.counterError.set('Failed to load results.'); },
    });
  }

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
