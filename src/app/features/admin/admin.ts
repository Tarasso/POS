import { Component, OnInit, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MenuService } from '../../core/services/menu.service';
import { Category, CategoryWithItems, MenuItem } from '../../core/models/menu.models';

interface CategoryForm {
  name: string;
  sortOrder: number;
}

interface ItemForm {
  name: string;
  categoryId: string;
  price: number | null;
  sortOrder: number;
}

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [FormsModule, CurrencyPipe],
  templateUrl: './admin.html',
  styleUrl: './admin.scss',
})
export class Admin implements OnInit {
  private menuService = inject(MenuService);

  // ── Exposed state from service ──────────────────────────────────────────
  readonly menu = this.menuService.menu;
  readonly loading = this.menuService.loading;
  readonly error = this.menuService.error;

  // ── Local UI state ──────────────────────────────────────────────────────
  readonly showAddCategory = signal(false);
  readonly editingCategory = signal<CategoryWithItems | null>(null);
  readonly addingItemToCategoryId = signal<string | null>(null);
  readonly editingItem = signal<MenuItem | null>(null);
  readonly saving = signal(false);

  // ── Forms (plain objects, not reactive forms — simple enough) ───────────
  categoryForm: CategoryForm = this._blankCategoryForm();
  itemForm: ItemForm = this._blankItemForm('');
  editCategoryForm: CategoryForm = this._blankCategoryForm();
  editItemForm: ItemForm = this._blankItemForm('');

  // ── Lifecycle ───────────────────────────────────────────────────────────
  ngOnInit(): void {
    this.menuService.loadMenu();
  }

  // ── Category actions ────────────────────────────────────────────────────

  openAddCategory(): void {
    this.categoryForm = this._blankCategoryForm();
    this.showAddCategory.set(true);
  }

  cancelAddCategory(): void {
    this.showAddCategory.set(false);
  }

  saveNewCategory(): void {
    const { name, sortOrder } = this.categoryForm;
    if (!name.trim()) return;
    this.saving.set(true);
    this.menuService.createCategory({ name: name.trim(), sortOrder }).subscribe({
      next: () => {
        this.showAddCategory.set(false);
        this.saving.set(false);
      },
      error: () => this.saving.set(false),
    });
  }

  startEditCategory(cat: CategoryWithItems): void {
    this.editCategoryForm = { name: cat.name, sortOrder: cat.sortOrder };
    this.editingCategory.set(cat);
  }

  cancelEditCategory(): void {
    this.editingCategory.set(null);
  }

  saveEditCategory(): void {
    const cat = this.editingCategory();
    if (!cat) return;
    const { name, sortOrder } = this.editCategoryForm;
    if (!name.trim()) return;
    this.saving.set(true);
    this.menuService.updateCategory(cat.id, { name: name.trim(), sortOrder }).subscribe({
      next: () => {
        this.editingCategory.set(null);
        this.saving.set(false);
      },
      error: () => this.saving.set(false),
    });
  }

  // ── Item actions ────────────────────────────────────────────────────────

  openAddItem(categoryId: string): void {
    this.itemForm = this._blankItemForm(categoryId);
    this.addingItemToCategoryId.set(categoryId);
  }

  cancelAddItem(): void {
    this.addingItemToCategoryId.set(null);
  }

  saveNewItem(): void {
    const { name, categoryId, price, sortOrder } = this.itemForm;
    if (!name.trim() || price === null) return;
    this.saving.set(true);
    this.menuService
      .createItem({ name: name.trim(), categoryId, price, sortOrder })
      .subscribe({
        next: () => {
          this.addingItemToCategoryId.set(null);
          this.saving.set(false);
        },
        error: () => this.saving.set(false),
      });
  }

  startEditItem(item: MenuItem): void {
    this.editItemForm = {
      name: item.name,
      categoryId: item.categoryId,
      price: item.price,
      sortOrder: item.sortOrder,
    };
    this.editingItem.set(item);
  }

  cancelEditItem(): void {
    this.editingItem.set(null);
  }

  saveEditItem(): void {
    const item = this.editingItem();
    if (!item) return;
    const { name, categoryId, price, sortOrder } = this.editItemForm;
    if (!name.trim() || price === null) return;
    this.saving.set(true);
    this.menuService
      .updateItem(item.id, { name: name.trim(), categoryId, price: price!, sortOrder })
      .subscribe({
        next: () => {
          this.editingItem.set(null);
          this.saving.set(false);
        },
        error: () => this.saving.set(false),
      });
  }

  toggleSoldOut(item: MenuItem): void {
    this.menuService.toggleSoldOut(item.id, !item.soldOut).subscribe();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  isEditingCategory(cat: CategoryWithItems): boolean {
    return this.editingCategory()?.id === cat.id;
  }

  isAddingItemTo(categoryId: string): boolean {
    return this.addingItemToCategoryId() === categoryId;
  }

  isEditingItem(item: MenuItem): boolean {
    return this.editingItem()?.id === item.id;
  }

  trackById(_: number, obj: Category | MenuItem): string {
    return obj.id;
  }

  private _blankCategoryForm(): CategoryForm {
    return { name: '', sortOrder: 0 };
  }

  private _blankItemForm(categoryId: string): ItemForm {
    return { name: '', categoryId, price: null, sortOrder: 0 };
  }
}
