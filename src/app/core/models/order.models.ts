/** One applied modifier choice — stored inside both CartItem and OrderLineItem. */
export interface AppliedModifier {
  groupId: string;
  groupName: string;
  optionId: string;
  optionName: string;
  /** Present only when the option has allowsCustomText=true and the user typed something. */
  customText?: string;
  /**
   * KDS pill background color (hex), snapshotted from ModifierOption.color at
   * order-placement time so the KDS always shows the color that was current
   * when the order was placed.
   */
  color?: string;
}

/** One line item inside an order — sent in the POST body and stored in Cosmos. */
export interface OrderLineItem {
  itemId: string;
  name: string;
  price: number;
  qty: number;
  modifiers: AppliedModifier[];
}

/** Full order document shape — mirrors the Cosmos 'orders' container document. */
export interface Order {
  id: string;
  status: 'open' | 'completed';
  customerName: string;
  items: OrderLineItem[];
  total: number;
  createdAt: string;
  completedAt: string | null;
}

/** Shape of GET /api/orders response. */
export interface OrdersResponse {
  orders: Order[];
}

/** Shape of POST /api/orders request body. */
export interface CreateOrderPayload {
  customerName: string;
  items: OrderLineItem[];
}

/**
 * Cart line item — in-memory only, never persisted directly.
 * Each add-to-cart creates a new line with a unique cartLineId, even for
 * the same menu item, so different modifier combinations stay separate.
 */
export interface CartItem {
  /** Unique key for this cart line. Generated client-side on add. */
  cartLineId: string;
  itemId: string;
  name: string;
  price: number;
  qty: number;
  modifiers: AppliedModifier[];
}
