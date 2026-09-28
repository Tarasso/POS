import { Routes } from '@angular/router';
import { fullAccessGuard, signedInGuard } from './core/guards/auth.guards';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./features/login/login').then(m => m.Login),
  },
  {
    path: 'order',
    canActivate: [signedInGuard],
    loadComponent: () =>
      import('./features/order/order').then(m => m.Order),
  },
  {
    path: 'kds',
    canActivate: [signedInGuard],
    loadComponent: () =>
      import('./features/kds/kds').then(m => m.Kds),
  },
  {
    path: 'counter',
    canActivate: [signedInGuard],
    loadComponent: () =>
      import('./features/counter/counter').then(m => m.Counter),
  },
  {
    path: 'admin',
    canActivate: [fullAccessGuard],
    loadComponent: () =>
      import('./features/admin/admin').then(m => m.Admin),
  },
  {
    path: 'analytics',
    canActivate: [fullAccessGuard],
    loadComponent: () =>
      import('./features/analytics/analytics').then(m => m.Analytics),
  },
  { path: '',   redirectTo: 'order', pathMatch: 'full' },
  { path: '**', redirectTo: 'order' },
];
