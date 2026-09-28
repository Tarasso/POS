import * as signalR from '@microsoft/signalr';
import { GUEST_TOKEN_HEADER, readGuestToken } from './auth.service';

/**
 * SignalR's negotiate call uses its own HTTP client, not Angular's, so the
 * guest-token interceptor doesn't apply. This adds the header to same-origin
 * requests only (POST /api/negotiate): the follow-up requests to the Azure
 * SignalR endpoint are cross-origin, and an extra custom header there would
 * trigger a CORS preflight the service may reject.
 */
export class GuestTokenHttpClient extends signalR.DefaultHttpClient {
  constructor() { super(signalR.NullLogger.instance); }

  override send(request: signalR.HttpRequest): Promise<signalR.HttpResponse> {
    const token = readGuestToken();
    const sameOrigin = new URL(request.url ?? '', window.location.origin).origin === window.location.origin;
    if (token && sameOrigin) {
      request.headers = { ...request.headers, [GUEST_TOKEN_HEADER]: token };
    }
    return super.send(request);
  }
}
