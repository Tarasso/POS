import { HttpInterceptorFn } from '@angular/common/http';
import { GUEST_TOKEN_HEADER, readGuestToken } from '../services/auth.service';

/** Attach the guest sign-in token (if this device has one) to every /api/* request. */
export const guestTokenInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) return next(req);
  const token = readGuestToken();
  return next(token ? req.clone({ setHeaders: { [GUEST_TOKEN_HEADER]: token } }) : req);
};
