import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import { Guest, GuestListResponse } from '../models/auth.models';

/** Guest (PIN) account management for the admin screen. Owner/staff only. */
@Injectable({ providedIn: 'root' })
export class GuestService {
  private http = inject(HttpClient);

  readonly guests = signal<Guest[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** False when the server has no GUEST_TOKEN_SECRET — guests can't sign in yet. */
  readonly guestLoginEnabled = signal(true);

  load(): void {
    this.loading.set(true);
    this.http.get<GuestListResponse>('/api/guests').subscribe({
      next: (data) => {
        this.guests.set(data.guests);
        this.guestLoginEnabled.set(data.guestLoginEnabled);
        this.error.set(null);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Failed to load guests.');
        this.loading.set(false);
      },
    });
  }

  create(name: string, pin: string): Observable<Guest> {
    return this.http.post<Guest>('/api/guests', { name, pin }).pipe(tap(() => this.load()));
  }

  update(id: string, changes: { name?: string; pin?: string }): Observable<Guest> {
    return this.http.put<Guest>(`/api/guests/${id}`, changes).pipe(tap(() => this.load()));
  }

  /** Sign this guest out on every device (PIN unchanged). */
  revoke(id: string): Observable<Guest> {
    return this.http.post<Guest>(`/api/guests/${id}/revoke`, {}).pipe(tap(() => this.load()));
  }

  remove(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/guests/${id}`).pipe(tap(() => this.load()));
  }
}
