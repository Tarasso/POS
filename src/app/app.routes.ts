import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: 'order',
    loadComponent: () =>
      import('./features/order/order').then(m => m.Order),
  },
  {
    path: 'kds',
    loadComponent: () =>
      import('./features/kds/kds').then(m => m.Kds),
  },
  {
    path: 'admin',
    loadComponent: () =>
      import('./features/admin/admin').then(m => m.Admin),
  },
  {
    path: 'analytics',
    loadComponent: () =>
      import('./features/analytics/analytics').then(m => m.Analytics),
  },
  { path: '',   redirectTo: 'order', pathMatch: 'full' },
  { path: '**', redirectTo: 'order' },
];
