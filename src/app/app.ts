import { Component, DestroyRef, inject, signal, computed, OnDestroy } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/services/auth.service';
import { PullRefreshService } from './core/services/pull-refresh.service';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { fromEvent, merge } from 'rxjs';
import { filter, map } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

/** How often (ms) to silently check for a new SW version in the foreground. */
const UPDATE_POLL_MS = 5 * 60 * 1_000; // 5 minutes
/** How often (ms) to check /api/auth/session for session expiry in the foreground. */
const SESSION_POLL_MS = 10 * 60 * 1_000; // 10 minutes
/** Pull distance (px, after resistance) needed to trigger a refresh. */
const PULL_TRIGGER_PX = 70;
/** Where the indicator rests while the refresh runs. */
const PULL_REST_PX = 56;
/** Keep the spinner up at least this long so the refresh is visibly acknowledged. */
const MIN_SPIN_MS = 600;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    @if (!onLoginPage()) {
    <nav class="app-nav">
      <span class="app-nav-brand">POS</span>
      <div class="app-nav-links">
        <a class="nav-link" routerLink="/order"     routerLinkActive="nav-link-active">Order</a>
        <a class="nav-link" routerLink="/kds"       routerLinkActive="nav-link-active">KDS</a>
        <a class="nav-link" routerLink="/counter"   routerLinkActive="nav-link-active">Counter</a>
        @if (hasFullAccess()) {
          <a class="nav-link" routerLink="/admin"     routerLinkActive="nav-link-active">Admin</a>
          <a class="nav-link" routerLink="/analytics" routerLinkActive="nav-link-active">Analytics</a>
        }
      </div>

      <div class="app-nav-right">
        <!--
          Reload button — right-aligned in the nav bar.
          · Normal:   muted ↻ icon, tap to manually check for updates
          · Checking: spinning ↻ while checkForUpdate() is in-flight
          · Ready:    pulsing blue ↻, tap applies the waiting update immediately
          · Up-to-date: brief ✓ flash, auto-reverts after 2 s
        -->
        <button
          class="nav-reload-btn"
          [class.is-checking]="checking()"
          [class.is-ready]="updateAvailable()"
          [class.is-ok]="upToDate()"
          (click)="manualCheck()"
          [title]="updateAvailable() ? 'Update ready — tap to reload' : 'Check for updates'"
          aria-label="Check for app updates"
        >
          <span class="nav-reload-icon">@if (upToDate()) { ✓ } @else { ↻ }</span>
        </button>

        <!-- Greeting chip — tap for the account menu (sign out lives here) -->
        <button class="user-chip" (click)="userMenuOpen.set(!userMenuOpen())"
                [attr.aria-expanded]="userMenuOpen()" aria-label="Account menu">
          <span class="user-avatar">{{ initial() }}</span>
          <span class="user-greeting">Hi, {{ firstName() || 'there' }}</span>
        </button>
      </div>
    </nav>

    @if (userMenuOpen()) {
      <div class="user-menu-backdrop" (click)="userMenuOpen.set(false)"></div>
      <div class="user-menu" role="menu">
        <div class="user-menu-name">{{ session()?.name }}</div>
        <div class="user-menu-role">{{ roleLabel() }}</div>
        <button class="user-menu-signout" role="menuitem" (click)="signOut()">Sign out</button>
      </div>
    }
    }

    <!-- Pull-to-refresh indicator — sits just below the nav bar -->
    @if (pullDistance() > 0 || refreshing()) {
      <div class="ptr" [style.transform]="'translate(-50%, ' + ptrOffset() + 'px)'"
           [style.opacity]="refreshing() ? 1 : pullProgress()">
        <span class="ptr-icon" [class.ptr-spin]="refreshing()"
              [style.transform]="refreshing() ? null : 'rotate(' + pullProgress() * 270 + 'deg)'">↻</span>
      </div>
    }

    @if (updateAvailable()) {
      <div class="update-banner" (click)="applyUpdate()">
        ↻ App updated — tap to refresh
      </div>
    }

    @if (isOffline()) {
      <div class="offline-banner">You're offline — orders can't be placed</div>
    }

    @if (sessionExpired()) {
      <div class="session-expired-banner">
        Session expired.
        <a class="session-expired-link" [href]="sessionExpiredLoginUrl()">Sign in</a>
      </div>
    }

    <div class="app-content" [class.app-content-bare]="onLoginPage()">
      <router-outlet />
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }

    /* ── Navigation bar ──────────────────────────────────────────────────── */
    .app-nav {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: var(--nav-h);
      padding-top: env(safe-area-inset-top, 0px);
      /* Landscape iPhone: keep content clear of the notch/island side insets */
      padding-left: max(1rem, env(safe-area-inset-left, 0px));
      padding-right: max(0.5rem, env(safe-area-inset-right, 0px));
      z-index: 50;
      background: #1e293b;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      /* Depth shadow — subtle bottom glow */
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.05), 0 2px 12px rgba(0, 0, 0, 0.3);
    }

    /* Brand wordmark with a small blue accent dot */
    .app-nav-brand {
      position: relative;
      font-size: 0.9375rem;
      font-weight: 800;
      color: #fff;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      flex-shrink: 0;

      &::after {
        content: '';
        position: absolute;
        bottom: -2px;
        left: 0;
        width: 1.25rem;
        height: 2px;
        background: #3b82f6;
        border-radius: 9999px;
      }
    }

    /* Links shrink first; if they still don't fit they scroll inside the bar
       rather than widening the page (the cause of the sideways scroll). */
    .app-nav-links {
      display: flex;
      align-items: center;
      gap: 0.125rem;
      flex: 1 1 auto;
      min-width: 0;
      overflow-x: auto;
      scrollbar-width: none;
      -webkit-overflow-scrolling: touch;

      &::-webkit-scrollbar { display: none; }
    }

    .app-nav-right {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      flex: 0 1 auto;
      min-width: 0;
    }

    .nav-link {
      color: #94a3b8;
      text-decoration: none;
      font-size: 0.8125rem;
      font-weight: 500;
      padding: 0.375rem 0.625rem;
      border-radius: 0.5rem;
      transition: color 0.12s, background 0.12s;
      white-space: nowrap;
      letter-spacing: 0.01em;

      &:hover {
        color: #e2e8f0;
        background: rgba(255, 255, 255, 0.08);
      }
    }

    .nav-link-active {
      color: #fff !important;
      background: rgba(255, 255, 255, 0.14) !important;
      font-weight: 600;
    }

    /* Reload button — first item in the right-hand group */
    .nav-reload-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2.125rem;
      height: 2.125rem;
      border: none;
      border-radius: 50%;
      background: transparent;
      color: #64748b;
      font-size: 1rem;
      cursor: pointer;
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
      transition: color 0.15s, background 0.15s, box-shadow 0.15s;

      &:hover {
        color: #cbd5e1;
        background: rgba(255, 255, 255, 0.1);
        box-shadow: 0 0 0 6px rgba(255, 255, 255, 0.05);
      }

      &:active {
        color: #cbd5e1;
        background: rgba(255, 255, 255, 0.14);
      }

      /* Update waiting — pulse sky-blue */
      &.is-ready {
        color: #38bdf8;
        animation: reload-pulse 1.8s ease-in-out infinite;
      }

      /* In-flight check — spin icon */
      &.is-checking .nav-reload-icon {
        display: inline-block;
        animation: spin 0.7s linear infinite;
      }

      /* Brief "up to date" confirmation — green */
      &.is-ok {
        color: #4ade80;
      }
    }

    .nav-reload-icon {
      line-height: 1;
      user-select: none;
    }

    /* ── Greeting chip + account menu ────────────────────────────────────── */
    .user-chip {
      display: flex;
      align-items: center;
      gap: 0.375rem;
      min-width: 0;
      height: 2.125rem;
      padding: 0 0.625rem 0 0.25rem;
      border: none;
      border-radius: 9999px;
      background: rgba(255, 255, 255, 0.08);
      color: #e2e8f0;
      font-family: inherit;
      font-size: 0.8125rem;
      font-weight: 500;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;

      &:active { background: rgba(255, 255, 255, 0.16); }
    }

    .user-avatar {
      flex-shrink: 0;
      display: grid;
      place-items: center;
      width: 1.625rem;
      height: 1.625rem;
      border-radius: 50%;
      background: #3b82f6;
      color: #fff;
      font-size: 0.75rem;
      font-weight: 700;
    }

    .user-greeting {
      min-width: 0;
      max-width: 7rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .user-menu-backdrop {
      position: fixed;
      inset: 0;
      z-index: 60;
    }

    .user-menu {
      position: fixed;
      top: calc(var(--nav-h) + 0.375rem);
      right: max(0.5rem, env(safe-area-inset-right, 0px));
      z-index: 61;
      min-width: 12rem;
      max-width: calc(100vw - 1rem);
      padding: 0.875rem;
      background: #fff;
      border-radius: 0.75rem;
      box-shadow: var(--shadow-lg);
    }

    .user-menu-name {
      font-weight: 700;
      font-size: 0.9375rem;
      color: var(--text-primary);
      overflow-wrap: anywhere;
    }

    .user-menu-role {
      font-size: 0.75rem;
      color: var(--text-muted);
      margin: 0.125rem 0 0.75rem;
    }

    .user-menu-signout {
      width: 100%;
      height: 2.5rem;
      border: 1px solid #fca5a5;
      border-radius: 0.5rem;
      background: #fff;
      color: var(--red);
      font-family: inherit;
      font-size: 0.9375rem;
      font-weight: 600;
      cursor: pointer;
    }

    /* ── Pull-to-refresh indicator ───────────────────────────────────────── */
    .ptr {
      position: fixed;
      top: var(--nav-h);
      left: 50%;
      z-index: 45; /* below the nav, so it slides out from under it */
      display: grid;
      place-items: center;
      width: 2.5rem;
      height: 2.5rem;
      margin-top: -2.5rem;
      border-radius: 50%;
      background: #fff;
      box-shadow: var(--shadow-md);
      pointer-events: none;
    }

    .ptr-icon {
      display: inline-block;
      font-size: 1.25rem;
      line-height: 1;
      color: var(--blue);
    }

    .ptr-spin { animation: spin 0.7s linear infinite; }

    /* ── Phones ──────────────────────────────────────────────────────────── */
    @media (max-width: 480px) {
      .app-nav {
        padding-left: max(0.5rem, env(safe-area-inset-left, 0px));
        padding-right: max(0.375rem, env(safe-area-inset-right, 0px));
        gap: 0.25rem;
      }

      /* The wordmark is decorative — give its space to the links. */
      .app-nav-brand { display: none; }

      .nav-link {
        padding: 0.375rem 0.5rem;
        font-size: 0.78rem;
      }

      .nav-reload-btn { width: 1.875rem; }

      .user-greeting { max-width: 4.75rem; }
    }

    /* ── Content wrapper ─────────────────────────────────────────────────── */
    .app-content {
      padding-top: var(--nav-clearance);
    }

    /* Login screen has no nav bar */
    .app-content-bare {
      padding-top: 0;
    }

    /* ── System banners ──────────────────────────────────────────────────── */
    .update-banner {
      background: linear-gradient(135deg, #0284c7, #0ea5e9);
      color: #fff;
      text-align: center;
      font-size: 0.875rem;
      font-weight: 600;
      padding: 0.5rem 1rem;
      cursor: pointer;
      z-index: 49;
      letter-spacing: 0.01em;
    }

    .offline-banner {
      background: linear-gradient(135deg, #92400e, #b45309);
      color: #fff;
      text-align: center;
      font-size: 0.875rem;
      font-weight: 600;
      padding: 0.4rem 1rem;
    }

    .session-expired-banner {
      background: #7c2d12;
      color: #fff;
      text-align: center;
      font-size: 0.875rem;
      font-weight: 600;
      padding: 0.4rem 1rem;
    }

    .session-expired-link {
      color: #fde68a;
      margin-left: 0.5rem;
      text-decoration: underline;
      font-weight: 700;
    }

    /* ── Keyframes ───────────────────────────────────────────────────────── */
    @keyframes reload-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.4; }
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `],
})
export class App implements OnDestroy {
  readonly updateAvailable = signal(false);
  readonly isOffline = signal(!navigator.onLine);
  /** True while checkForUpdate() is in-flight. */
  readonly checking = signal(false);
  /** Briefly true after a manual check finds no update. Auto-clears after 2 s. */
  readonly upToDate = signal(false);
  /** True when the session poll detects the session has expired mid-session. */
  readonly sessionExpired = signal(false);
  readonly sessionExpiredLoginUrl = computed(() => {
    this.currentUrl(); // recompute on navigation
    const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
    return `/login?returnUrl=${returnUrl}`;
  });

  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly pullRefresh = inject(PullRefreshService);
  readonly hasFullAccess = this.auth.hasFullAccess;

  // ── Greeting / account menu ────────────────────────────────────────────────
  readonly session = this.auth.session;
  readonly firstName = this.auth.firstName;
  readonly initial = computed(() => (this.firstName() || '?').charAt(0).toUpperCase());
  readonly roleLabel = computed(() => {
    switch (this.session()?.role) {
      case 'owner': return 'Owner';
      case 'staff': return 'Staff';
      case 'guest': return 'Guest — Order & KDS';
      default:      return '';
    }
  });
  readonly userMenuOpen = signal(false);

  // ── Pull-to-refresh ────────────────────────────────────────────────────────
  // iOS's native pull-to-refresh (and rubber-band bounce) is disabled in
  // styles.scss because it slid the page under the fixed nav. This replaces it
  // with an indicator that appears *below* the nav and refreshes the current
  // page's data in place (see PullRefreshService).
  readonly pullDistance = signal(0);
  readonly refreshing = signal(false);
  readonly pullProgress = computed(() => Math.min(this.pullDistance() / PULL_TRIGGER_PX, 1));
  /** How far the indicator has slid down out from under the nav. */
  readonly ptrOffset = computed(() => (this.refreshing() ? PULL_REST_PX : this.pullDistance()));
  private pullStartY: number | null = null;
  // Seeded from location (router.url is still "/" before the first navigation).
  private readonly currentUrl = signal(window.location.pathname);
  readonly onLoginPage = computed(() => this.currentUrl().startsWith('/login'));

  private readonly swUpdate = inject(SwUpdate);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private sessionPollTimer: ReturnType<typeof setInterval> | null = null;
  private upToDateTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityHandler: (() => Promise<void>) | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);

    // ── SW update notification ──────────────────────────────────────────────
    if (this.swUpdate.isEnabled) {
      this.swUpdate.versionUpdates
        .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
        .subscribe(() => this.updateAvailable.set(true));

      // Poll for updates every 5 minutes while the app is in the foreground.
      // Angular's NGSW only checks on navigation by default; without this,
      // a mobile user who keeps the PWA open never sees the update banner.
      this.pollTimer = setInterval(() => {
        this.swUpdate.checkForUpdate().catch(() => { /* ignore offline errors */ });
      }, UPDATE_POLL_MS);
    }

    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd), takeUntilDestroyed(destroyRef))
      .subscribe(e => {
        this.currentUrl.set(e.urlAfterRedirects);
        this.userMenuOpen.set(false);
        if (e.urlAfterRedirects.startsWith('/login')) this.sessionExpired.set(false);
      });

    // ── Proactive session expiry detection ─────────────────────────────────
    // The visibilitychange handler catches foreground→background→foreground
    // transitions. This poll handles session expiry while the app stays
    // continuously in the foreground (e.g., KDS left open overnight).
    // Microsoft sessions expire; guest tokens only end on sign-out or revoke.
    this.sessionPollTimer = setInterval(async () => {
      if (document.visibilityState !== 'visible' || this.onLoginPage()) return;
      try {
        const session = await this.auth.refresh();
        this.sessionExpired.set(!session.authenticated);
      } catch { /* offline / cold start — ignore */ }
    }, SESSION_POLL_MS);

    // ── Offline / online detection ──────────────────────────────────────────
    merge(
      fromEvent(window, 'online').pipe(map(() => false)),
      fromEvent(window, 'offline').pipe(map(() => true)),
    ).pipe(takeUntilDestroyed(destroyRef))
      .subscribe(offline => this.isOffline.set(offline));

    // ── Visibility: session check + pre-warm on foreground ──────────────────
    // When the PWA comes back to the foreground after hours/days, ask the API
    // who we are. That one call both verifies the (possibly cached) session —
    // bouncing to /login if it's gone — and pre-warms the Azure Function cold
    // start so it's ready by the time the user interacts with the UI.
    this.visibilityHandler = async () => {
      if (document.visibilityState !== 'visible' || this.onLoginPage()) return;
      try {
        const session = await this.auth.refresh();
        if (!session.authenticated && !this.onLoginPage()) {
          const returnUrl = window.location.pathname + window.location.search;
          this.router.navigate(['/login'], { queryParams: { returnUrl } });
        }
      } catch { /* offline / still cold — the interceptor handles API errors */ }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
    this.visibilityHandler(); // also run once on cold launch — visibilitychange never fires then

    // ── Pull-to-refresh gesture ─────────────────────────────────────────────
    const passive = { passive: true };
    fromEvent<TouchEvent>(document, 'touchstart', passive)
      .pipe(takeUntilDestroyed(destroyRef)).subscribe(e => this.onPullStart(e));
    fromEvent<TouchEvent>(document, 'touchmove', passive)
      .pipe(takeUntilDestroyed(destroyRef)).subscribe(e => this.onPullMove(e));
    merge(fromEvent(document, 'touchend', passive), fromEvent(document, 'touchcancel', passive))
      .pipe(takeUntilDestroyed(destroyRef)).subscribe(() => this.onPullEnd());
  }

  private onPullStart(e: TouchEvent): void {
    if (this.refreshing() || this.onLoginPage() || this.userMenuOpen()) return;
    if (e.touches.length !== 1 || window.scrollY > 0) return;
    if (this.startsInBlockedArea(e.target)) return;
    this.pullStartY = e.touches[0].clientY;
  }

  private onPullMove(e: TouchEvent): void {
    if (this.pullStartY === null) return;
    const dy = e.touches[0].clientY - this.pullStartY;
    if (dy < -10 || window.scrollY > 0) {
      // Scrolling up/normally, not pulling — abandon the gesture.
      this.pullStartY = null;
      this.pullDistance.set(0);
      return;
    }
    // Resistance: the indicator moves at half the finger's speed, capped.
    this.pullDistance.set(Math.max(0, Math.min(dy * 0.5, 110)));
  }

  private onPullEnd(): void {
    if (this.pullStartY === null) return;
    this.pullStartY = null;
    const triggered = this.pullDistance() >= PULL_TRIGGER_PX;
    this.pullDistance.set(0);
    if (triggered) void this.runPullRefresh();
  }

  private async runPullRefresh(): Promise<void> {
    this.refreshing.set(true);
    const started = Date.now();
    if (this.swUpdate.isEnabled) this.swUpdate.checkForUpdate().catch(() => {});
    try {
      await this.pullRefresh.run();
    } finally {
      const remaining = MIN_SPIN_MS - (Date.now() - started);
      if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
      this.refreshing.set(false);
    }
  }

  /**
   * Don't hijack drags that begin inside bottom sheets, side panels, overlays or
   * the nav (anything fixed-position), or inside a box that's scrolled down.
   */
  private startsInBlockedArea(target: EventTarget | null): boolean {
    for (let el = target as HTMLElement | null; el && el !== document.body; el = el.parentElement) {
      if (el.scrollTop > 0) return true;
      if (getComputedStyle(el).position === 'fixed') return true;
    }
    return false;
  }

  ngOnDestroy(): void {
    if (this.pollTimer)        clearInterval(this.pollTimer);
    if (this.sessionPollTimer) clearInterval(this.sessionPollTimer);
    if (this.upToDateTimer)    clearTimeout(this.upToDateTimer);
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  signOut(): void {
    this.userMenuOpen.set(false);
    this.auth.signOut();
  }

  applyUpdate(): void {
    this.swUpdate.activateUpdate().then(() => window.location.reload());
  }

  /**
   * Manual update check triggered by the ↻ nav button.
   *
   * · If an update is already waiting  → apply it immediately (same as banner tap).
   * · If SW is disabled (local dev)    → hard-reload the page.
   * · Otherwise                        → call checkForUpdate(); spin the icon
   *   while in-flight; if a new version is found the VERSION_READY event fires
   *   and the blue "App updated" banner appears automatically; if already
   *   current, show a brief ✓ for 2 seconds.
   */
  async manualCheck(): Promise<void> {
    if (this.updateAvailable()) {
      this.applyUpdate();
      return;
    }

    if (!this.swUpdate.isEnabled) {
      window.location.reload();
      return;
    }

    if (this.checking()) return; // already in-flight, ignore double-tap

    this.checking.set(true);
    this.upToDate.set(false);
    if (this.upToDateTimer) { clearTimeout(this.upToDateTimer); this.upToDateTimer = null; }

    try {
      const found = await this.swUpdate.checkForUpdate();
      if (!found) {
        // Already on the latest version — show brief ✓ confirmation.
        this.upToDate.set(true);
        this.upToDateTimer = setTimeout(() => {
          this.upToDate.set(false);
          this.upToDateTimer = null;
        }, 2_000);
      }
      // If found === true, VERSION_READY fires shortly and sets updateAvailable.
    } catch {
      // Ignore — likely offline; user will see the offline banner.
    } finally {
      this.checking.set(false);
    }
  }
}
