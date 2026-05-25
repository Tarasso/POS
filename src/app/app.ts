import { Component, DestroyRef, inject, signal, OnDestroy } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { fromEvent, merge } from 'rxjs';
import { filter, map } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

/** How often (ms) to silently check for a new SW version in the foreground. */
const UPDATE_POLL_MS = 5 * 60 * 1_000; // 5 minutes

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <nav class="app-nav">
      <span class="app-nav-brand">POS</span>
      <div class="app-nav-links">
        <a class="nav-link" routerLink="/order"     routerLinkActive="nav-link-active">Order</a>
        <a class="nav-link" routerLink="/kds"       routerLinkActive="nav-link-active">KDS</a>
        <a class="nav-link" routerLink="/admin"     routerLinkActive="nav-link-active">Admin</a>
        <a class="nav-link" routerLink="/analytics" routerLinkActive="nav-link-active">Analytics</a>

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

        <a class="nav-link nav-link-signout" href="/.auth/logout">Sign out</a>
      </div>
    </nav>

    @if (updateAvailable()) {
      <div class="update-banner" (click)="applyUpdate()">
        ↻ App updated — tap to refresh
      </div>
    }

    @if (isOffline()) {
      <div class="offline-banner">You're offline — orders can't be placed</div>
    }

    <div class="app-content">
      <router-outlet />
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }

    .app-nav {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: calc(2.75rem + env(safe-area-inset-top, 0px));
      padding-top: env(safe-area-inset-top, 0px);
      z-index: 50;
      background: #1e293b;
      display: flex;
      align-items: center;
      padding-left: 1rem;
      padding-right: 1rem;
      gap: 1rem;
    }

    .app-nav-brand {
      font-size: 0.875rem;
      font-weight: 800;
      color: #fff;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      flex-shrink: 0;
    }

    .app-nav-links {
      display: flex;
      align-items: center;
      gap: 0.125rem;
      flex: 1;
    }

    .nav-link {
      color: #94a3b8;
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 500;
      padding: 0.3125rem 0.625rem;
      border-radius: 0.375rem;
      transition: color 0.1s, background 0.1s;
      white-space: nowrap;
    }

    .nav-link:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.08);
    }

    .nav-link-active {
      color: #fff;
      background: rgba(255, 255, 255, 0.12);
    }

    /* Push the reload button + sign-out link to the far right */
    .nav-reload-btn {
      margin-left: auto;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2rem;
      height: 2rem;
      border: none;
      border-radius: 50%;
      background: transparent;
      color: #64748b;
      font-size: 1rem;
      cursor: pointer;
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
      transition: color 0.15s, background 0.15s;

      &:hover, &:active {
        color: #cbd5e1;
        background: rgba(255, 255, 255, 0.08);
      }

      /* Update is downloaded and waiting — pulse blue to draw attention */
      &.is-ready {
        color: #38bdf8;
        animation: reload-pulse 1.8s ease-in-out infinite;
      }

      /* checkForUpdate() in-flight — spin the icon */
      &.is-checking .nav-reload-icon {
        display: inline-block;
        animation: spin 0.7s linear infinite;
      }

      /* Brief "up to date" confirmation — green tick */
      &.is-ok {
        color: #4ade80;
      }
    }

    .nav-reload-icon {
      line-height: 1;
      user-select: none;
    }

    .nav-link-signout {
      /* no margin-left: auto here — the reload button above handles that */
      color: #94a3b8;
      text-decoration: none;
      font-size: 0.875rem;
      font-weight: 500;
      padding: 0.3125rem 0.625rem;
      border-radius: 0.375rem;
      transition: color 0.1s, background 0.1s;
      white-space: nowrap;

      &:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.08);
      }
    }

    .app-content {
      padding-top: calc(2.75rem + env(safe-area-inset-top, 0px));
    }

    .update-banner {
      background: #0ea5e9;
      color: #fff;
      text-align: center;
      font-size: 0.875rem;
      font-weight: 600;
      padding: 0.5rem;
      cursor: pointer;
      z-index: 49;
    }

    .offline-banner {
      background: #b45309;
      color: #fff;
      text-align: center;
      font-size: 0.875rem;
      font-weight: 600;
      padding: 0.375rem;
    }

    @keyframes reload-pulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.45; }
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

  private readonly swUpdate = inject(SwUpdate);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private upToDateTimer: ReturnType<typeof setTimeout> | null = null;

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

    // ── Offline / online detection ──────────────────────────────────────────
    merge(
      fromEvent(window, 'online').pipe(map(() => false)),
      fromEvent(window, 'offline').pipe(map(() => true)),
    ).pipe(takeUntilDestroyed(destroyRef))
      .subscribe(offline => this.isOffline.set(offline));
  }

  ngOnDestroy(): void {
    if (this.pollTimer)     clearInterval(this.pollTimer);
    if (this.upToDateTimer) clearTimeout(this.upToDateTimer);
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
