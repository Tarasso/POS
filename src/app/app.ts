import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

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
        <a class="nav-link nav-link-signout" href="/.auth/logout">Sign out</a>
      </div>
    </nav>
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
      height: 2.75rem;
      z-index: 50;
      background: #1e293b;
      display: flex;
      align-items: center;
      padding: 0 1rem;
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

    .nav-link-signout {
      margin-left: auto;
    }

    .app-content {
      padding-top: 2.75rem;
    }
  `],
})
export class App {}
