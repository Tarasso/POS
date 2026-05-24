import { Component, OnInit, inject, signal } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MenuService } from '../../core/services/menu.service';
import {
  Category,
  CategoryWithItems,
  MenuItem,
  ModifierGroup,
  ModifierGroupWithOptions,
  ModifierOption,
} from '../../core/models/menu.models';

// ── Form interfaces ────────────────────────────────────────────────────────────

interface CategoryForm { name: string; sortOrder: number; }
interface ItemForm     { name: string; categoryId: string; price: number | null; sortOrder: number; }

interface ModifierGroupForm {
  name: string;
  minSelections: number;
  maxUnlimited: boolean;
  maxSelections: number;
  sortOrder: number;
}

interface ModifierOptionForm {
  name: string;
  isDefault: boolean;
  allowsCustomText: boolean;
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

  readonly menu      = this.menuService.menu;
  readonly loading   = this.menuService.loading;
  readonly error     = this.menuService.error;
  readonly saving    = signal(false);
  readonly saveError = signal<string | null>(null);

  // ── Category UI state ──────────────────────────────────────────────────────
  readonly showAddCategory    = signal(false);
  readonly editingCategory    = signal<CategoryWithItems | null>(null);
  readonly addingItemToCatId  = signal<string | null>(null);
  readonly editingItem        = signal<MenuItem | null>(null);

  categoryForm:     CategoryForm = this._blankCategoryForm();
  editCategoryForm: CategoryForm = this._blankCategoryForm();
  itemForm:         ItemForm     = this._blankItemForm('');
  editItemForm:     ItemForm     = this._blankItemForm('');

  // ── Modifier group UI state ────────────────────────────────────────────────
  readonly showAddGroup    = signal(false);
  readonly editingGroup    = signal<ModifierGroupWithOptions | null>(null);
  readonly addingOptToGrpId = signal<string | null>(null);
  readonly editingOption   = signal<ModifierOption | null>(null);
  /** The modifier group whose item-assignment panel is currently open. */
  readonly assigningGroupId = signal<string | null>(null);
  /** itemId → checked (working state while assignment panel is open). */
  readonly assigningSelections = signal<Record<string, boolean>>({});

  groupForm:      ModifierGroupForm   = this._blankGroupForm();
  editGroupForm:  ModifierGroupForm   = this._blankGroupForm();
  optionForm:     ModifierOptionForm  = this._blankOptionForm();
  editOptionForm: ModifierOptionForm  = this._blankOptionForm();

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  ngOnInit(): void { this.menuService.loadMenu(); }

  // ═══════════════════════════════════════════════════════════════════════════
  // CATEGORY ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  openAddCategory(): void {
    this.categoryForm = this._blankCategoryForm();
    this.showAddCategory.set(true);
  }
  cancelAddCategory(): void { this.showAddCategory.set(false); }
  saveNewCategory(): void {
    const { name, sortOrder } = this.categoryForm;
    if (!name.trim()) return;
    this.saveError.set(null);
    this.saving.set(true);
    this.menuService.createCategory({ name: name.trim(), sortOrder }).subscribe({
      next: () => { this.showAddCategory.set(false); this.saving.set(false); },
      error: () => { this.saving.set(false); this.saveError.set('Save failed. Please try again.'); },
    });
  }

  startEditCategory(cat: CategoryWithItems): void {
    this.editCategoryForm = { name: cat.name, sortOrder: cat.sortOrder };
    this.editingCategory.set(cat);
  }
  cancelEditCategory(): void { this.editingCategory.set(null); }
  saveEditCategory(): void {
    const cat = this.editingCategory();
    if (!cat) return;
    const { name, sortOrder } = this.editCategoryForm;
    if (!name.trim()) return;
    this.saveError.set(null);
    this.saving.set(true);
    this.menuService.updateCategory(cat.id, { name: name.trim(), sortOrder }).subscribe({
      next: () => { this.editingCategory.set(null); this.saving.set(false); },
      error: () => { this.saving.set(false); this.saveError.set('Save failed. Please try again.'); },
    });
  }

  // ── Item actions ────────────────────────────────────────────────────────────
  openAddItem(categoryId: string): void {
    this.itemForm = this._blankItemForm(categoryId);
    this.addingItemToCatId.set(categoryId);
  }
  cancelAddItem(): void { this.addingItemToCatId.set(null); }
  saveNewItem(): void {
    const { name, categoryId, price, sortOrder } = this.itemForm;
    if (!name.trim() || price === null) return;
    this.saveError.set(null);
    this.saving.set(true);
    this.menuService.createItem({ name: name.trim(), categoryId, price, sortOrder }).subscribe({
      next: () => { this.addingItemToCatId.set(null); this.saving.set(false); },
      error: () => { this.saving.set(false); this.saveError.set('Save failed. Please try again.'); },
    });
  }

  startEditItem(item: MenuItem): void {
    this.editItemForm = { name: item.name, categoryId: item.categoryId, price: item.price, sortOrder: item.sortOrder };
    this.editingItem.set(item);
  }
  cancelEditItem(): void { this.editingItem.set(null); }
  saveEditItem(): void {
    const item = this.editingItem();
    if (!item) return;
    const { name, categoryId, price, sortOrder } = this.editItemForm;
    if (!name.trim() || price === null) return;
    this.saveError.set(null);
    this.saving.set(true);
    this.menuService.updateItem(item.id, { name: name.trim(), categoryId, price: price!, sortOrder }).subscribe({
      next: () => { this.editingItem.set(null); this.saving.set(false); },
      error: () => { this.saving.set(false); this.saveError.set('Save failed. Please try again.'); },
    });
  }

  toggleSoldOut(item: MenuItem): void {
    this.menuService.toggleSoldOut(item.id, !item.soldOut).subscribe();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODIFIER GROUP ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  openAddGroup(): void {
    this.groupForm = this._blankGroupForm();
    this.showAddGroup.set(true);
  }
  cancelAddGroup(): void { this.showAddGroup.set(false); }
  saveNewGroup(): void {
    if (!this.groupForm.name.trim()) return;
    const max = this.groupForm.maxUnlimited ? null : this.groupForm.maxSelections;
    this.saveError.set(null);
    this.saving.set(true);
    this.menuService.createModifierGroup({
      name: this.groupForm.name.trim(),
      minSelections: this.groupForm.minSelections,
      maxSelections: max,
      sortOrder: this.groupForm.sortOrder,
    }).subscribe({
      next: () => { this.showAddGroup.set(false); this.saving.set(false); },
      error: () => { this.saving.set(false); this.saveError.set('Save failed. Please try again.'); },
    });
  }

  startEditGroup(group: ModifierGroupWithOptions): void {
    this.editGroupForm = {
      name: group.name,
      minSelections: group.minSelections,
      maxUnlimited: group.maxSelections === null,
      maxSelections: group.maxSelections ?? 1,
      sortOrder: group.sortOrder,
    };
    this.editingGroup.set(group);
  }
  cancelEditGroup(): void { this.editingGroup.set(null); }
  saveEditGroup(): void {
    const group = this.editingGroup();
    if (!group || !this.editGroupForm.name.trim()) return;
    const max = this.editGroupForm.maxUnlimited ? null : this.editGroupForm.maxSelections;
    this.saveError.set(null);
    this.saving.set(true);
    this.menuService.updateModifierGroup(group.id, {
      name: this.editGroupForm.name.trim(),
      minSelections: this.editGroupForm.minSelections,
      maxSelections: max,
      sortOrder: this.editGroupForm.sortOrder,
    }).subscribe({
      next: () => { this.editingGroup.set(null); this.saving.set(false); },
      error: () => { this.saving.set(false); this.saveError.set('Save failed. Please try again.'); },
    });
  }

  deleteGroup(group: ModifierGroupWithOptions): void {
    if (!confirm(`Delete "${group.name}" and all its options? Items assigned to this group will be unassigned.`)) return;
    this.saveError.set(null);
    this.saving.set(true);
    this.menuService.deleteModifierGroup(group.id).subscribe({
      next: () => this.saving.set(false),
      error: () => { this.saving.set(false); this.saveError.set('Delete failed. Please try again.'); },
    });
  }

  // ── Modifier option actions ────────────────────────────────────────────────

  openAddOption(groupId: string): void {
    this.optionForm = this._blankOptionForm();
    this.addingOptToGrpId.set(groupId);
  }
  cancelAddOption(): void { this.addingOptToGrpId.set(null); }
  saveNewOption(): void {
    const groupId = this.addingOptToGrpId();
    if (!groupId || !this.optionForm.name.trim()) return;
    this.saveError.set(null);
    this.saving.set(true);
    this.menuService.createModifierOption({
      groupId,
      name: this.optionForm.name.trim(),
      isDefault: this.optionForm.isDefault,
      allowsCustomText: this.optionForm.allowsCustomText,
      sortOrder: this.optionForm.sortOrder,
    }).subscribe({
      next: () => { this.addingOptToGrpId.set(null); this.saving.set(false); },
      error: () => { this.saving.set(false); this.saveError.set('Save failed. Please try again.'); },
    });
  }

  startEditOption(option: ModifierOption): void {
    this.editOptionForm = {
      name: option.name,
      isDefault: option.isDefault,
      allowsCustomText: option.allowsCustomText,
      sortOrder: option.sortOrder,
    };
    this.editingOption.set(option);
  }
  cancelEditOption(): void { this.editingOption.set(null); }
  saveEditOption(): void {
    const option = this.editingOption();
    if (!option || !this.editOptionForm.name.trim()) return;
    this.saveError.set(null);
    this.saving.set(true);
    this.menuService.updateModifierOption(option.id, {
      name: this.editOptionForm.name.trim(),
      isDefault: this.editOptionForm.isDefault,
      allowsCustomText: this.editOptionForm.allowsCustomText,
      sortOrder: this.editOptionForm.sortOrder,
    }).subscribe({
      next: () => { this.editingOption.set(null); this.saving.set(false); },
      error: () => { this.saving.set(false); this.saveError.set('Save failed. Please try again.'); },
    });
  }

  deleteOption(option: ModifierOption): void {
    if (!confirm(`Delete option "${option.name}"?`)) return;
    this.saveError.set(null);
    this.saving.set(true);
    this.menuService.deleteModifierOption(option.id).subscribe({
      next: () => this.saving.set(false),
      error: () => { this.saving.set(false); this.saveError.set('Delete failed. Please try again.'); },
    });
  }

  // ── Item assignment ────────────────────────────────────────────────────────

  openAssignPanel(group: ModifierGroupWithOptions): void {
    const checked: Record<string, boolean> = {};
    this.menu()?.categories.forEach(cat =>
      cat.items.forEach(item => {
        checked[item.id] = (item.modifierGroupIds ?? []).includes(group.id);
      })
    );
    this.assigningSelections.set(checked);
    this.assigningGroupId.set(group.id);
  }

  closeAssignPanel(): void { this.assigningGroupId.set(null); }

  toggleItemAssignment(itemId: string): void {
    this.assigningSelections.update(m => ({ ...m, [itemId]: !m[itemId] }));
  }

  isCategoryFullyChecked(cat: CategoryWithItems): boolean {
    const sels = this.assigningSelections();
    return cat.items.length > 0 && cat.items.every(i => !!sels[i.id]);
  }

  isCategoryPartiallyChecked(cat: CategoryWithItems): boolean {
    const sels = this.assigningSelections();
    const n = cat.items.filter(i => !!sels[i.id]).length;
    return n > 0 && n < cat.items.length;
  }

  toggleCategoryAssignment(cat: CategoryWithItems): void {
    const check = !this.isCategoryFullyChecked(cat);
    this.assigningSelections.update(m => {
      const updated = { ...m };
      cat.items.forEach(i => { updated[i.id] = check; });
      return updated;
    });
  }

  saveAssignments(): void {
    const groupId = this.assigningGroupId();
    if (!groupId) return;

    const sels = this.assigningSelections();
    const allItems = this.menu()?.categories.flatMap(c => c.items) ?? [];

    const add    = allItems.filter(i =>  sels[i.id] && !(i.modifierGroupIds ?? []).includes(groupId)).map(i => i.id);
    const remove = allItems.filter(i => !sels[i.id] &&  (i.modifierGroupIds ?? []).includes(groupId)).map(i => i.id);

    if (add.length === 0 && remove.length === 0) {
      this.assigningGroupId.set(null);
      return;
    }

    this.saveError.set(null);
    this.saving.set(true);
    this.menuService.assignModifierGroup(groupId, { add, remove }).subscribe({
      next: () => { this.assigningGroupId.set(null); this.saving.set(false); },
      error: () => { this.saving.set(false); this.saveError.set('Save failed. Please try again.'); },
    });
  }

  // ── Template predicate helpers ─────────────────────────────────────────────

  isEditingCategory(cat: CategoryWithItems): boolean { return this.editingCategory()?.id === cat.id; }
  isAddingItemTo(catId: string): boolean { return this.addingItemToCatId() === catId; }
  isEditingItem(item: MenuItem): boolean { return this.editingItem()?.id === item.id; }
  isEditingGroup(group: ModifierGroupWithOptions): boolean { return this.editingGroup()?.id === group.id; }
  isAddingOptionTo(groupId: string): boolean { return this.addingOptToGrpId() === groupId; }
  isEditingOption(option: ModifierOption): boolean { return this.editingOption()?.id === option.id; }
  isAssigning(groupId: string): boolean { return this.assigningGroupId() === groupId; }

  groupRuleLabel(group: ModifierGroup): string {
    const min = group.minSelections;
    const max = group.maxSelections;
    if (min === 0 && max === null) return 'Optional, unlimited';
    if (min === 1 && max === 1)    return 'Required — 1';
    if (min === max)               return `Required — ${min}`;
    if (max === null)              return `${min}+ required`;
    return `${min}–${max}`;
  }

  trackById(_: number, obj: Category | MenuItem | ModifierGroup | ModifierOption): string {
    return obj.id;
  }

  // ── Private blank-form factories ───────────────────────────────────────────

  private _blankCategoryForm(): CategoryForm { return { name: '', sortOrder: 0 }; }
  private _blankItemForm(catId: string): ItemForm { return { name: '', categoryId: catId, price: null, sortOrder: 0 }; }
  private _blankGroupForm(): ModifierGroupForm { return { name: '', minSelections: 0, maxUnlimited: false, maxSelections: 1, sortOrder: 0 }; }
  private _blankOptionForm(): ModifierOptionForm { return { name: '', isDefault: false, allowsCustomText: false, sortOrder: 0 }; }
}
