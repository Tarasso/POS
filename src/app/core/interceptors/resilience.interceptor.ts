import { HttpInterceptorFn } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import { inject } from '@angular/core';
import { throwError, timer, from, NEVER } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';

/**
 * Retry delays for Azure Functions cold-start (504).
 * Three attempts: 3 s, 8 s, 20 s — covers ~31 s of warm-up time.
 */
const BACKOFF_DELAYS = [3_000, 8_000, 20_000];

/**
 * Checks /.auth/me with native fetch (avoids HttpClient circular dependency).
 * Returns true if the user has a valid SWA session, false if the session expired.
 * Fails open (returns true) on network error so we don't redirect on offline blips.
 */
async function checkAuth(): Promise<boolean> {
  try {
    const res = await fetch('/.auth/me', { credentials: 'same-origin' });
    if (!res.ok) return true;
    const json = await res.json();
    return json?.clientPrincipal != null;
  } catch {
    return true;
  }
}

/**
 * Resilience interceptor — applied to /api/* requests only.
 *
 * 504 (cold start): retries up to 3 times with increasing backoff so the
 * component stays in its Loading… state rather than immediately showing an error.
 *
 * Status 0 while online (SWA auth redirect → CORS block): calls /.auth/me to
 * distinguish an expired session from a transient network glitch.
 *   - Session expired → redirect to /.auth/login/aad (page navigates, no error shown).
 *   - Still authenticated → retry once after 1 s.
 */
export const resilienceInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) return next(req);

  const doc = inject(DOCUMENT);
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

        // ── 401: raw SWA unauthorized — redirect immediately, no auth check ──
        // (SWA normally converts 401→302→CORS-block→status 0, but belt-and-
        //  suspenders for edge cases and the SW transition window after Fix 1)
        if (status === 401) {
          const returnUrl = encodeURIComponent(
            doc.defaultView!.location.pathname + doc.defaultView!.location.search
          );
          doc.defaultView!.location.href = `/.auth/login/aad?post_login_redirect_uri=${returnUrl}`;
          return NEVER;
        }

        // ── Status 0 while online: likely SWA auth redirect (CORS block) ───
        if (status === 0 && navigator.onLine) {
          return from(checkAuth()).pipe(
            switchMap(authed => {
              if (!authed) {
                const returnUrl = encodeURIComponent(
                  doc.defaultView!.location.pathname + doc.defaultView!.location.search
                );
                doc.defaultView!.location.href = `/.auth/login/aad?post_login_redirect_uri=${returnUrl}`;
                return NEVER;
              }
              if (attempt < 1) {
                attempt++;
                return timer(1_000).pipe(switchMap(() => attempt$()));
              }
              return throwError(() => err);
            }),
          );
        }

        return throwError(() => err);
      }),
    );

  return attempt$();
};
