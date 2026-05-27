import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, forkJoin, tap } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  Category,
  CategoryWithItems,
  MenuItem,
  MenuTree,
  ModifierGroup,
  ModifierGroupWithOptions,
  ModifierOption,
} from '../models/menu.models';

@Injectable({ providedIn: 'root' })
export class MenuService {
  private http = inject(HttpClient);

  // ── Public state signals ────────────────────────────────────────────────
  readonly menu = signal<MenuTree | null>(null);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  // ── Read ────────────────────────────────────────────────────────────────

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

  createCategory(payload: { name: string; sortOrder: number; parentId?: string | null; color?: string }): Observable<Category> {
    return this.http.post<Category>('/api/menu/categories', payload).pipe(
      tap(() => this.loadMenu()),
    );
  }

  updateCategory(
    id: string,
    payload: Partial<Pick<Category, 'name' | 'sortOrder' | 'parentId' | 'color'>>,
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
    color?: string;
  }): Observable<MenuItem> {
    return this.http.post<MenuItem>('/api/menu/items', payload).pipe(
      tap(() => this.loadMenu()),
    );
  }

  updateItem(
    id: string,
    payload: Partial<Pick<MenuItem, 'name' | 'categoryId' | 'price' | 'sortOrder' | 'color'>>,
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

  deleteItem(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/menu/items/${id}`).pipe(
      tap(() => this.loadMenu()),
    );
  }

  deleteCategory(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/menu/categories/${id}`).pipe(
      tap(() => this.loadMenu()),
    );
  }

  /** Optimistically reorder items in the local signal (instant visual feedback). */
  updateMenuItemOrder(catId: string, reordered: MenuItem[]): void {
    this.menu.update(tree => {
      if (!tree) return tree;
      return {
        ...tree,
        categories: tree.categories.map(cat =>
          cat.id === catId ? { ...cat, items: reordered } : cat,
        ),
      };
    });
  }

  /** Persist new sort orders for a list of items, then reload. */
  reorderItems(updates: { id: string; sortOrder: number }[]): Observable<void> {
    const calls = updates.map(u =>
      this.http.put<MenuItem>(`/api/menu/items/${u.id}`, { sortOrder: u.sortOrder }),
    );
    return forkJoin(calls).pipe(
      map(() => undefined as void),
      tap(() => this.loadMenu()),
    );
  }

  // ── Modifier group mutations ────────────────────────────────────────────

  createModifierGroup(payload: {
    name: string;
    minSelections: number;
    maxSelections: number | null;
    sortOrder: number;
  }): Observable<ModifierGroup> {
    return this.http.post<ModifierGroup>('/api/menu/modifier-groups', payload).pipe(
      tap(() => this.loadMenu()),
    );
  }

  updateModifierGroup(
    id: string,
    payload: Partial<Pick<ModifierGroup, 'name' | 'minSelections' | 'maxSelections' | 'sortOrder'>>,
  ): Observable<ModifierGroup> {
    return this.http.put<ModifierGroup>(`/api/menu/modifier-groups/${id}`, payload).pipe(
      tap(() => this.loadMenu()),
    );
  }

  deleteModifierGroup(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/menu/modifier-groups/${id}`).pipe(
      tap(() => this.loadMenu()),
    );
  }

  /** Bulk-assign a modifier group to items. add/remove are arrays of item IDs. */
  assignModifierGroup(
    groupId: string,
    payload: { add: string[]; remove: string[] },
  ): Observable<{ ok: boolean }> {
    return this.http
      .patch<{ ok: boolean }>(`/api/menu/modifier-groups/${groupId}/items`, payload)
      .pipe(tap(() => this.loadMenu()));
  }

  // ── Modifier option mutations ───────────────────────────────────────────

  createModifierOption(payload: {
    groupId: string;
    name: string;
    isDefault: boolean;
    allowsCustomText: boolean;
    sortOrder: number;
    color?: string;
  }): Observable<ModifierOption> {
    return this.http.post<ModifierOption>('/api/menu/modifier-options', payload).pipe(
      tap(() => this.loadMenu()),
    );
  }

  updateModifierOption(
    id: string,
    payload: Partial<Pick<ModifierOption, 'name' | 'isDefault' | 'allowsCustomText' | 'sortOrder' | 'color'>>,
  ): Observable<ModifierOption> {
    return this.http.put<ModifierOption>(`/api/menu/modifier-options/${id}`, payload).pipe(
      tap(() => this.loadMenu()),
    );
  }

  deleteModifierOption(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/menu/modifier-options/${id}`).pipe(
      tap(() => this.loadMenu()),
    );
  }

  // ── Convenience helpers ─────────────────────────────────────────────────

  get categories(): CategoryWithItems[] {
    return this.menu()?.categories ?? [];
  }

  get modifierGroups(): ModifierGroupWithOptions[] {
    return this.menu()?.modifierGroups ?? [];
  }
}
