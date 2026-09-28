export type Role = 'owner' | 'staff' | 'guest';

/** Shape of GET /api/auth/session (and POST /api/auth/guest-login on success). */
export interface Session {
  authenticated: boolean;
  kind?: 'microsoft' | 'guest';
  role?: Role;
  name?: string;
  /** Set when signed in with Microsoft but not invited (no staff/owner role). */
  microsoftUser?: string | null;
  /** Guest JWT — returned on PIN login and when the server refreshes it. Stored separately, never cached in the session. */
  guestToken?: string;
}

/** Guest account as returned by GET /api/guests — PIN is never sent back. */
export interface Guest {
  id: string;
  name: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface GuestListResponse {
  guests: Guest[];
  /** False when GUEST_TOKEN_SECRET isn't configured on the server. */
  guestLoginEnabled: boolean;
}
