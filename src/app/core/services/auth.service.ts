import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, firstValueFrom, tap } from 'rxjs';
import { Session } from '../models/auth.models';

/** localStorage key for the last known session — lets the PWA open instantly on cold start. */
export const SESSION_CACHE_KEY = 'pos_session';

/**
 * localStorage key for the guest JWT. Sent as the X-Guest-Token header on every
 * /api call (see guestTokenInterceptor + KdsService). A cookie can't be used:
 * Azure Static Web Apps strips Set-Cookie from managed-Function responses.
 */
export const GUEST_TOKEN_KEY = 'pos_guest_token';
export const GUEST_TOKEN_HEADER = 'X-Guest-Token';

export function readGuestToken(): string | null {
  try { return localStorage.getItem(GUEST_TOKEN_KEY); } catch { return null; }
}

/** Forget this device's sign-in (both the guest token and the cached session). */
export function clearStoredAuth(): void {
  try {
    localStorage.removeItem(GUEST_TOKEN_KEY);
    localStorage.removeItem(SESSION_CACHE_KEY);
  } catch { /* storage unavailable */ }
}

function readCachedSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

/**
 * Who is signed in, and what they may see.
 *
 * Two sign-in paths share one session shape:
 *   · Microsoft (SWA built-in auth, owner/staff) — full access
 *   · Guest PIN (token from /api/auth/guest-login, kept in localStorage) — Order + KDS only
 *
 * The API is the real gatekeeper; this service only drives routing and nav.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  private inflight: Promise<Session> | null = null;

  /** Last known session. Seeded from localStorage so guards don't wait on a cold-start API call. */
  readonly session = signal<Session | null>(readCachedSession());

  readonly isAuthenticated = computed(() => this.session()?.authenticated === true);
  readonly isGuest         = computed(() => this.session()?.role === 'guest');
  readonly hasFullAccess   = computed(() => {
    const role = this.session()?.role;
    return this.isAuthenticated() && (role === 'owner' || role === 'staff');
  });

  /** Ask the API who we are. Concurrent callers share one request. */
  refresh(): Promise<Session> {
    if (!this.inflight) {
      this.inflight = firstValueFrom(this.http.get<Session>('/api/auth/session'))
        .then(s => { this.store(s); return s; })
        .finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  guestLogin(pin: string): Observable<Session> {
    return this.http.post<Session>('/api/auth/guest-login', { pin }).pipe(
      tap(s => this.store(s)),
    );
  }

  /** Microsoft sign-in (SWA built-in auth). Returns to `returnUrl` afterwards. */
  microsoftLoginUrl(returnUrl = '/order'): string {
    return `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(returnUrl)}`;
  }

  signOut(): void {
    const kind = this.session()?.kind;
    this.session.set(null);
    clearStoredAuth();
    window.location.href = kind === 'microsoft'
      ? '/.auth/logout?post_logout_redirect_uri=/login'
      : '/login';
  }

  private store(s: Session | null): void {
    const { guestToken, ...session } = s ?? {} as Session;
    this.session.set(s ? session : null);
    try {
      if (guestToken) localStorage.setItem(GUEST_TOKEN_KEY, guestToken);
      if (s?.authenticated) {
        localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(session));
      } else {
        // Not signed in — any stored guest token is dead (revoked, deleted, or PIN changed).
        clearStoredAuth();
      }
    } catch { /* storage unavailable — session just won't be cached */ }
  }
}
