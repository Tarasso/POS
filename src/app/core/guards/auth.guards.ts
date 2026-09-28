import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { AuthService } from '../services/auth.service';

/**
 * Resolve whether anyone is signed in. Uses the cached session when present so
 * the PWA opens instantly; App re-verifies with the API in the background and
 * bounces to /login if the session turns out to be gone.
 */
async function ensureSignedIn(returnUrl: string): Promise<true | UrlTree> {
  const auth = inject(AuthService);
  const router = inject(Router);
  const loginTree = router.createUrlTree(['/login'], { queryParams: { returnUrl } });

  if (auth.isAuthenticated()) return true;
  try {
    const session = await auth.refresh();
    return session.authenticated ? true : loginTree;
  } catch {
    return loginTree;
  }
}

/** Order + KDS — any signed-in user, guests included. */
export const signedInGuard: CanActivateFn = (_route, state) => ensureSignedIn(state.url);

/** Admin + Analytics — Microsoft owner/staff only. Guests are sent to the order screen. */
export const fullAccessGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const result = await ensureSignedIn(state.url);
  if (result !== true) return result;
  return auth.hasFullAccess() ? true : router.createUrlTree(['/order']);
};
