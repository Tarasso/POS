import { HttpInterceptorFn } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import { inject } from '@angular/core';
import { throwError, timer, NEVER } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { SESSION_CACHE_KEY } from '../services/auth.service';

/**
 * Retry delays for Azure Functions cold-start (504).
 * Three attempts: 3 s, 8 s, 20 s — covers ~31 s of warm-up time.
 */
const BACKOFF_DELAYS = [3_000, 8_000, 20_000];

/**
 * Resilience interceptor — applied to /api/* requests only.
 *
 * 504 (cold start): retries up to 3 times with increasing backoff so the
 * component stays in its Loading… state rather than immediately showing an error.
 *
 * 401 (not signed in / session revoked): the Functions enforce auth themselves
 * and return a plain JSON 401. Drop the cached session and go to /login, which
 * offers both the guest PIN pad and Microsoft sign-in. /api/auth/* calls are
 * exempt — the login page handles their errors inline.
 *
 * Status 0 while online: transient network glitch — retry once after 1 s.
 */
export const resilienceInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) return next(req);

  const doc = inject(DOCUMENT);
  const isAuthCall = req.url.startsWith('/api/auth/');
  let attempt = 0;

  const attempt$ = (): ReturnType<typeof next> =>
    next(req).pipe(
      catchError(err => {
        const status: number = err.status ?? 0;

        // ── 504: Azure Functions cold-start retry with backoff ─────────────
        if (status === 504 && attempt < BACKOFF_DELAYS.length) {
          const delay = BACKOFF_DELAYS[attempt++];
          return timer(delay).pipe(switchMap(() => attempt$()));
        }

        // ── 401: signed out, guest deleted, or PIN changed → login screen ──
        if (status === 401 && !isAuthCall) {
          const loc = doc.defaultView!.location;
          if (!loc.pathname.startsWith('/login')) {
            try { localStorage.removeItem(SESSION_CACHE_KEY); } catch { /* ignore */ }
            const returnUrl = encodeURIComponent(loc.pathname + loc.search);
            loc.href = `/login?returnUrl=${returnUrl}`;
          }
          return NEVER;
        }

        // ── Status 0 while online: transient glitch — retry once ───────────
        if (status === 0 && navigator.onLine && attempt < 1) {
          attempt++;
          return timer(1_000).pipe(switchMap(() => attempt$()));
        }

        return throwError(() => err);
      }),
    );

  return attempt$();
};
