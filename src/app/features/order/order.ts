import { Component, OnInit, inject, signal, computed, ViewChild, ElementRef, ChangeDetectorRef } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MenuService } from '../../core/services/menu.service';
import { OrderService } from '../../core/services/order.service';
import { CategoryWithItems, MenuItem, ModifierGroupWithOptions } from '../../core/models/menu.models';
import { AppliedModifier, CartItem } from '../../core/models/order.models';

type View = 'menu' | 'category' | 'modifiers';

@Component({
  selector: 'app-order',
  standalone: true,
  imports: [FormsModule, CurrencyPipe],
  templateUrl: './order.html',
  styleUrl: './order.scss',
})
export class Order implements OnInit {
  private menuService = inject(MenuService);
  private orderService = inject(OrderService);
  private cdr = inject(ChangeDetectorRef);

  // ── Menu state ────────────────────────────────────────────────────────────
  readonly menu = this.menuService.menu;
  readonly menuLoading = this.menuService.loading;
  readonly menuError = this.menuService.error;

  // ── Cart state ────────────────────────────────────────────────────────────
  readonly cart = this.orderService.cart;
  readonly cartCount = this.orderService.cartCount;
  readonly cartTotal = this.orderService.cartTotal;
  readonly canSubmit = this.orderService.canSubmit;
  readonly submitting = this.orderService.submitting;
  readonly submitError = this.orderService.submitError;
  readonly lastSubmittedOrder = this.orderService.lastSubmittedOrder;

  // ── ngModel bridge (signals can't be two-way bound directly) ──────────────
  get customerName(): string { return this.orderService.customerName(); }
  set customerName(value: string) { this.orderService.customerName.set(value); }

  // ── Event name (exposed for template) ────────────────────────────────────
  readonly eventName = this.orderService.eventName;

  // ── View state ────────────────────────────────────────────────────────────
  readonly currentView = signal<View>('menu');
  readonly selectedCategory = signal<CategoryWithItems | null>(null);

  // ── Sheet state ───────────────────────────────────────────────────────────
  readonly showCartPreview = signal(false);
  readonly showNamePrompt = signal(false);
  readonly showEventSheet = signal(false);

  // ── Event sheet draft ─────────────────────────────────────────────────────
  private readonly _eventNameDraft = signal('');
  get eventNameDraft(): string { return this._eventNameDraft(); }
  set eventNameDraft(v: string) { this._eventNameDraft.set(v); }

  /** Template ref for the name input so we can programmatically focus it. */
  @ViewChild('nameInput') private nameInputRef?: ElementRef<HTMLInputElement>;

  // ── Modifier selection state ──────────────────────────────────────────────
  readonly pendingItem = signal<MenuItem | null>(null);
  /** groupId → array of selected optionIds */
  readonly pendingSelections = signal<Record<string, string[]>>({});
  /** optionId → custom text (only for allowsCustomText options) */
  readonly pendingCustomTexts = signal<Record<string, string>>({});

  /** Modifier groups that apply to the item currently being configured. */
  readonly activeModifierGroups = computed<ModifierGroupWithOptions[]>(() => {
    const item = this.pendingItem();
    const tree = this.menu();
    if (!item || !tree) return [];
    const ids = item.modifierGroupIds ?? [];
    return tree.modifierGroups
      .filter(g => ids.includes(g.id))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  });

  /** True when every required modifier group has its minSelections met. */
  readonly canAddToCart = computed<boolean>(() => {
    const selections = this.pendingSelections();
    return this.activeModifierGroups().every(g =>
      (selections[g.id]?.length ?? 0) >= g.minSelections
    );
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  ngOnInit(): void {
    this.menuService.loadMenu();
  }

  // ── Top-level navigation ──────────────────────────────────────────────────
  showMenu(): void {
    this.selectedCategory.set(null);
    this.currentView.set('menu');
  }

  showCategory(cat: CategoryWithItems): void {
    this.selectedCategory.set(cat);
    this.currentView.set('category');
  }

  // ── Item tap (decides: modifiers view or direct add) ─────────────────────
  addToCart(item: MenuItem): void {
    if (item.soldOut) return;
    const groups = (this.menu()?.modifierGroups ?? [])
      .filter(g => (item.modifierGroupIds ?? []).includes(g.id));

    if (groups.length > 0) {
      this.startModify(item, groups);
    } else {
      this.orderService.addItem(item.id, item.name, item.price, []);
    }
  }

  // ── Modifier view ─────────────────────────────────────────────────────────
  private startModify(item: MenuItem, groups: ModifierGroupWithOptions[]): void {
    const initial: Record<string, string[]> = {};
    for (const group of groups) {
      initial[group.id] = group.options.filter(o => o.isDefault).map(o => o.id);
    }
    this.pendingItem.set(item);
    this.pendingSelections.set(initial);
    this.pendingCustomTexts.set({});
    this.currentView.set('modifiers');
  }

  cancelModify(): void {
    this.pendingItem.set(null);
    this.pendingSelections.set({});
    this.pendingCustomTexts.set({});
    this.currentView.set('category');
  }

  toggleModifierOption(groupId: string, optionId: string, maxSelections: number | null): void {
    this.pendingSelections.update(current => {
      const existing = current[groupId] ?? [];
      const alreadySelected = existing.includes(optionId);

      if (alreadySelected) {
        return { ...current, [groupId]: existing.filter(id => id !== optionId) };
      }
      if (maxSelections === 1) {
        return { ...current, [groupId]: [optionId] };
      }
      if (maxSelections !== null && existing.length >= maxSelections) {
        return current;
      }
      return { ...current, [groupId]: [...existing, optionId] };
    });
  }

  isOptionSelected(groupId: string, optionId: string): boolean {
    return (this.pendingSelections()[groupId] ?? []).includes(optionId);
  }

  setCustomText(optionId: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.pendingCustomTexts.update(c => ({ ...c, [optionId]: value }));
  }

  addPendingToCart(): void {
    const item = this.pendingItem();
    if (!item || !this.canAddToCart()) return;

    const selections = this.pendingSelections();
    const customTexts = this.pendingCustomTexts();
    const modifiers: AppliedModifier[] = [];

    for (const group of this.activeModifierGroups()) {
      for (const optionId of selections[group.id] ?? []) {
        const option = group.options.find(o => o.id === optionId);
        if (!option) continue;
        const customText = option.allowsCustomText ? (customTexts[optionId] || undefined) : undefined;
        modifiers.push({
          groupId: group.id,
          groupName: group.name,
          optionId: option.id,
          optionName: option.name,
          ...(customText ? { customText } : {}),
          // Snapshot the KDS pill color at order-placement time so the KDS
          // always renders the color that was set when the order was placed.
          ...(option.color ? { color: option.color } : {}),
        });
      }
    }

    this.orderService.addItem(item.id, item.name, item.price, modifiers);
    this.cancelModify();
  }

  selectionRuleLabel(group: ModifierGroupWithOptions): string {
    const { minSelections: min, maxSelections: max } = group;
    if (min === 0 && max === null) return 'Optional';
    if (min === 0 && max === 1)    return 'Optional, up to 1';
    if (min === 1 && max === 1)    return 'Required — choose 1';
    if (min === max)               return `Required — choose ${min}`;
    if (max === null)              return min > 0 ? `Choose at least ${min}` : 'Optional';
    return `Choose ${min}–${max}`;
  }

  // ── Cart actions ──────────────────────────────────────────────────────────
  increment(cartLineId: string): void { this.orderService.incrementItem(cartLineId); }
  decrement(cartLineId: string): void { this.orderService.decrementItem(cartLineId); }
  remove(cartLineId: string): void    { this.orderService.removeItem(cartLineId); }

  // ── Cart preview sheet ────────────────────────────────────────────────────
  openCartPreview(): void    { this.showCartPreview.set(true); }
  closeCartPreview(): void   { this.showCartPreview.set(false); }
  /** Tapping the cart-peek button a second time collapses the preview. */
  toggleCartPreview(): void  { this.showCartPreview.update(v => !v); }

  // ── Name prompt sheet ─────────────────────────────────────────────────────
  openNamePrompt(): void {
    this.showCartPreview.set(false); // close cart sheet if open
    this.showNamePrompt.set(true);
    // iOS Safari only triggers the soft keyboard when focus() is called
    // within the same user-gesture tick. detectChanges() forces Angular to
    // render the name-sheet template synchronously so the input element is
    // in the DOM before we focus it — no setTimeout needed.
    this.cdr.detectChanges();
    const el = this.nameInputRef?.nativeElement;
    if (el) {
      el.focus();
    } else {
      // Fallback: element not yet available, try in the next microtask.
      // This keeps us inside the gesture window on most browsers.
      setTimeout(() => this.nameInputRef?.nativeElement?.focus(), 0);
    }
  }

  closeNamePrompt(): void { this.showNamePrompt.set(false); }

  /**
   * Called by the Place Order button inside the name prompt AND by the Enter
   * key on the name input.  Keeps the sheet open while the request is in-flight
   * so the user sees the "Placing Order…" state; the success overlay covers
   * everything on success.
   */
  submitFromNamePrompt(): void {
    if (!this.canSubmit()) return;
    this.orderService.submitOrder();
  }

  retryLoadMenu(): void { this.menuService.loadMenu(); }

  // ── Event name sheet ──────────────────────────────────────────────────────
  openEventSheet(): void {
    this._eventNameDraft.set(this.orderService.eventName());
    this.showEventSheet.set(true);
  }

  saveEventName(): void {
    this.orderService.setEventName(this._eventNameDraft());
    this.showEventSheet.set(false);
  }

  closeEventSheet(): void { this.showEventSheet.set(false); }

  startNewOrder(): void {
    this.orderService.resetAfterConfirmation();
    this.currentView.set('menu');
    this.showCartPreview.set(false);
    this.showNamePrompt.set(false);
  }

  // ── Template helpers ──────────────────────────────────────────────────────
  modifierSummary(modifiers: AppliedModifier[]): string {
    return modifiers
      .map(m => m.customText ? `${m.optionName}: "${m.customText}"` : m.optionName)
      .join(' · ');
  }

  trackByCartLineId(_: number, item: CartItem): string {
    return item.cartLineId;
  }
}
