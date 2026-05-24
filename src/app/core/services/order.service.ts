import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { AppliedModifier, CartItem, CreateOrderPayload, Order } from '../models/order.models';

@Injectable({ providedIn: 'root' })
export class OrderService {
  private http = inject(HttpClient);

  // ── Cart state ────────────────────────────────────────────────────────────
  readonly cart = signal<CartItem[]>([]);
  readonly customerName = signal<string>('');

  // ── Submission state ──────────────────────────────────────────────────────
  readonly submitting = signal<boolean>(false);
  readonly submitError = signal<string | null>(null);
  readonly lastSubmittedOrder = signal<Order | null>(null);

  // ── Computed cart values ──────────────────────────────────────────────────
  readonly cartCount = computed(() =>
    this.cart().reduce((sum, item) => sum + item.qty, 0)
  );

  readonly cartTotal = computed(() =>
    this.cart().reduce((sum, item) => sum + item.price * item.qty, 0)
  );

  readonly canSubmit = computed(() =>
    this.customerName().trim().length > 0 &&
    this.cart().length > 0 &&
    !this.submitting()
  );

  // ── Cart mutations ────────────────────────────────────────────────────────

  /**
   * Add an item to the cart as a new line (always a new entry, even if the
   * same itemId is already present — modifier combinations must stay separate).
   */
  addItem(itemId: string, name: string, price: number, modifiers: AppliedModifier[]): void {
    const cartLineId = Math.random().toString(36).slice(2, 10);
    this.cart.update(current => [
      ...current,
      { cartLineId, itemId, name, price, qty: 1, modifiers },
    ]);
  }

  /** Increment qty of a specific cart line by 1. */
  incrementItem(cartLineId: string): void {
    this.cart.update(current =>
      current.map(c => c.cartLineId === cartLineId ? { ...c, qty: c.qty + 1 } : c)
    );
  }

  /** Decrement qty by 1; removes the line when qty reaches 0. */
  decrementItem(cartLineId: string): void {
    this.cart.update(current => {
      const item = current.find(c => c.cartLineId === cartLineId);
      if (!item) return current;
      if (item.qty <= 1) return current.filter(c => c.cartLineId !== cartLineId);
      return current.map(c => c.cartLineId === cartLineId ? { ...c, qty: c.qty - 1 } : c);
    });
  }

  /** Remove a cart line entirely regardless of qty. */
  removeItem(cartLineId: string): void {
    this.cart.update(current => current.filter(c => c.cartLineId !== cartLineId));
  }

  // ── Order submission ──────────────────────────────────────────────────────

  submitOrder(): void {
    if (!this.canSubmit()) return;

    this.submitting.set(true);
    this.submitError.set(null);

    const payload: CreateOrderPayload = {
      customerName: this.customerName().trim(),
      items: this.cart().map(c => ({
        itemId: c.itemId,
        name: c.name,
        price: c.price,
        qty: c.qty,
        modifiers: c.modifiers,
      })),
    };

    this.http.post<Order>('/api/orders', payload).subscribe({
      next: (order) => {
        this.lastSubmittedOrder.set(order);
        this.cart.set([]);
        this.customerName.set('');
        this.submitting.set(false);
      },
      error: (err) => {
        console.error('Failed to submit order', err);
        this.submitError.set('Failed to place order. Please try again.');
        this.submitting.set(false);
      },
    });
  }

  // ── Post-success reset ────────────────────────────────────────────────────

  resetAfterConfirmation(): void {
    this.lastSubmittedOrder.set(null);
    this.submitError.set(null);
  }
}
