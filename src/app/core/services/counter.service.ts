import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom } from 'rxjs';
import * as signalR from '@microsoft/signalr';
import {
  CounterEvent, CounterEventPayload, CounterSnapshot, CounterTally,
} from '../models/counter.models';
import { GuestTokenHttpClient } from './signalr-http-client';

const STATION_KEY = 'pos_counter_station';
/** After a burst of taps settles, re-read the server counts once to guarantee convergence. */
const RESYNC_AFTER_TAPS_MS = 1_500;

export type CounterConnection = 'disconnected' | 'connecting' | 'connected' | 'error';

function tallyKey(station: number, itemId: string): string {
  return `${station}|${itemId}`;
}

/**
 * Ticket Counter state: the active event, live per-station counts, and this
 * device's station. Counts update optimistically on tap; the server's atomic
 * count is the source of truth and wins once in-flight taps settle.
 */
@Injectable({ providedIn: 'root' })
export class CounterService {
  private http = inject(HttpClient);
  private hub: signalR.HubConnection | null = null;

  readonly event = signal<CounterEvent | null>(null);
  readonly loading = signal(false);
  readonly loaded = signal(false);
  readonly error = signal<string | null>(null);
  readonly connection = signal<CounterConnection>('disconnected');

  /** "station|itemId" → count */
  private readonly counts = signal<Record<string, number>>({});

  /** This device's station (remembered across launches). */
  readonly station = signal<number | null>(readStation());

  /** Taps in flight per key — server echoes are held back until they settle. */
  private readonly pending = new Map<string, number>();
  private readonly lastServerCount = new Map<string, number>();
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;

  readonly stations = computed(() =>
    Array.from({ length: this.event()?.stationCount ?? 0 }, (_, i) => i + 1)
  );

  count(station: number, itemId: string): number {
    return this.counts()[tallyKey(station, itemId)] ?? 0;
  }

  itemTotal(itemId: string): number {
    return this.stations().reduce((sum, s) => sum + this.count(s, itemId), 0);
  }

  stationTotal(station: number): number {
    return (this.event()?.items ?? []).reduce((sum, i) => sum + this.count(station, i.id), 0);
  }

  readonly grandTotal = computed(() =>
    Object.values(this.counts()).reduce((a, b) => a + b, 0)
  );

  selectStation(station: number): void {
    this.station.set(station);
    try { localStorage.setItem(STATION_KEY, String(station)); } catch { /* ignore */ }
  }

  // ── Loading + live updates ────────────────────────────────────────────────

  async load(): Promise<void> {
    this.loading.set(true);
    try {
      const snap = await firstValueFrom(this.http.get<CounterSnapshot>('/api/counter/active'));
      this.event.set(snap.event);
      this.applySnapshot(snap.tallies);
      // Forget a station this event doesn't have (e.g. switched to a 1-station event).
      const st = this.station();
      if (snap.event && st && st > snap.event.stationCount) this.station.set(null);
      // Single-station events need no picker.
      if (snap.event?.stationCount === 1) this.station.set(1);
      this.error.set(null);
    } catch {
      this.error.set('Couldn’t load the counter. Pull down to retry.');
    } finally {
      this.loading.set(false);
      this.loaded.set(true);
    }
  }

  connect(): void {
    if (this.hub) return;
    this.hub = new signalR.HubConnectionBuilder()
      .withUrl('/api', { httpClient: new GuestTokenHttpClient() })
      .withAutomaticReconnect()
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    this.hub.on('counterUpdated', (t: { eventId: string; station: number; itemId: string; count: number }) => {
      if (t.eventId !== this.event()?.id) return;
      this.applyServerCount(tallyKey(t.station, t.itemId), t.count);
    });
    // Owner changed the drink list, renamed something, or switched events.
    this.hub.on('counterChanged', () => { void this.load(); });

    this.hub.onreconnecting(() => this.connection.set('connecting'));
    this.hub.onreconnected(() => { this.connection.set('connected'); void this.load(); });
    this.hub.onclose(() => this.connection.set('disconnected'));

    this.connection.set('connecting');
    this.hub.start()
      .then(() => { this.connection.set('connected'); void this.load(); })
      .catch(() => this.connection.set('error'));
  }

  disconnect(): void {
    this.hub?.stop();
    this.hub = null;
    this.connection.set('disconnected');
    if (this.resyncTimer) { clearTimeout(this.resyncTimer); this.resyncTimer = null; }
  }

  // ── Tapping ───────────────────────────────────────────────────────────────

  tap(itemId: string, delta: 1 | -1): void {
    const event = this.event();
    const station = this.station();
    if (!event || !station) return;
    const key = tallyKey(station, itemId);
    if (delta < 0 && this.count(station, itemId) <= 0) return;

    this.bump(key, delta);
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);

    this.http.post<{ count: number }>('/api/counter/tap', {
      eventId: event.id, station, itemId, delta,
    }).subscribe({
      next: (res) => {
        this.lastServerCount.set(key, res.count);
        this.settle(key);
      },
      error: (err) => {
        this.bump(key, -delta); // undo the optimistic change
        this.error.set(err?.status === 409
          ? 'This event was closed. Reloading…'
          : 'That tap didn’t save — check the count and tap again.');
        if (err?.status === 409) void this.load();
        this.settle(key);
      },
    });
  }

  clearError(): void { this.error.set(null); }

  // ── Owner: manage events ──────────────────────────────────────────────────

  listEvents(): Observable<{ events: CounterEvent[] }> {
    return this.http.get<{ events: CounterEvent[] }>('/api/counter/events');
  }

  createEvent(payload: CounterEventPayload): Observable<CounterEvent> {
    return this.http.post<CounterEvent>('/api/counter/events', payload);
  }

  updateEvent(id: string, payload: CounterEventPayload): Observable<CounterEvent> {
    return this.http.put<CounterEvent>(`/api/counter/events/${id}`, payload);
  }

  deleteEvent(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/counter/events/${id}`);
  }

  results(id: string): Observable<CounterSnapshot> {
    return this.http.get<CounterSnapshot>(`/api/counter/events/${id}/results`);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private bump(key: string, delta: number): void {
    this.counts.update(c => ({ ...c, [key]: Math.max(0, (c[key] ?? 0) + delta) }));
  }

  private applyServerCount(key: string, count: number): void {
    this.lastServerCount.set(key, count);
    if ((this.pending.get(key) ?? 0) > 0) return; // our own taps still in flight
    this.counts.update(c => ({ ...c, [key]: count }));
  }

  private settle(key: string): void {
    const left = (this.pending.get(key) ?? 1) - 1;
    if (left > 0) { this.pending.set(key, left); return; }
    this.pending.delete(key);
    const server = this.lastServerCount.get(key);
    if (server !== undefined) this.counts.update(c => ({ ...c, [key]: server }));
    // Responses to rapid taps can arrive out of order — re-read once things go quiet.
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      if (this.pending.size === 0) void this.load();
    }, RESYNC_AFTER_TAPS_MS);
  }

  private applySnapshot(tallies: CounterTally[]): void {
    const next: Record<string, number> = {};
    for (const t of tallies) next[tallyKey(t.station, t.itemId)] = t.count;
    // Keep optimistic values for keys with taps still in flight.
    const current = this.counts();
    for (const key of this.pending.keys()) next[key] = current[key] ?? next[key] ?? 0;
    this.counts.set(next);
  }
}

function readStation(): number | null {
  try {
    const n = Number(localStorage.getItem(STATION_KEY));
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
