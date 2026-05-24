import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, tap } from 'rxjs';
import {
  Category,
  CategoryWithItems,
  MenuItem,
  MenuTree,
} from '../models/menu.models';

@Injectable({ providedIn: 'root' })
export class MenuService {
  private http = inject(HttpClient);

  // ── Public state signals ────────────────────────────────────────────────
  readonly menu = signal<MenuTree | null>(null);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  // ── Read ────────────────────────────────────────────────────────────────

  /** Fetch the full menu tree and store it in the `menu` signal. */
  loadMenu(): void {
    this.loading.set(true);
    this.error.set(null);

    this.http.get<MenuTree>('/api/menu').subscribe({
      next: (tree) => {
        this.menu.set(tree);
        this.loading.set(false);
      },
      error: (err) => {
        console.error('Failed to load menu', err);
        this.error.set('Failed to load menu. Please try again.');
        this.loading.set(false);
      },
    });
  }

  // ── Category mutations ──────────────────────────────────────────────────

  createCategory(payload: { name: string; sortOrder: number; parentId?: string | null }): Observable<Category> {
    return this.http.post<Category>('/api/menu/categories', payload).pipe(
      tap(() => this.loadMenu()),
    );
  }

  updateCategory(
    id: string,
    payload: Partial<Pick<Category, 'name' | 'sortOrder' | 'parentId'>>,
  ): Observable<Category> {
    return this.http.put<Category>(`/api/menu/categories/${id}`, payload).pipe(
      tap(() => this.loadMenu()),
    );
  }

  // ── Item mutations ──────────────────────────────────────────────────────

  createItem(payload: {
    name: string;
    categoryId: string;
    price: number;
    sortOrder: number;
  }): Observable<MenuItem> {
    return this.http.post<MenuItem>('/api/menu/items', payload).pipe(
      tap(() => this.loadMenu()),
    );
  }

  updateItem(
    id: string,
    payload: Partial<Pick<MenuItem, 'name' | 'categoryId' | 'price' | 'sortOrder'>>,
  ): Observable<MenuItem> {
    return this.http.put<MenuItem>(`/api/menu/items/${id}`, payload).pipe(
      tap(() => this.loadMenu()),
    );
  }

  toggleSoldOut(id: string, soldOut: boolean): Observable<MenuItem> {
    return this.http
      .patch<MenuItem>(`/api/menu/items/${id}/soldout`, { soldOut })
      .pipe(tap(() => this.loadMenu()));
  }

  // ── Convenience computed helpers ────────────────────────────────────────

  /** Return a flat list of all categories from the current menu signal. */
  get categories(): CategoryWithItems[] {
    return this.menu()?.categories ?? [];
  }
}
