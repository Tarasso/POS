import { Order } from './order.models';

// ── Modifier breakdown ────────────────────────────────────────────────────────

/** Count of one modifier option across all orders in the filtered period. */
export interface ModifierOptionStat {
  optionName: string;
  count: number;
}

/** All option counts for one modifier group (e.g. "Drink Type": Hot 45, Iced 32). */
export interface ModifierGroupStat {
  groupName: string;
  /** Sorted highest → lowest count. */
  options: ModifierOptionStat[];
}

// ── Events ────────────────────────────────────────────────────────────────────

/** Summary of a named event derived from stored orders. */
export interface EventSummary {
  name: string;
  orderCount: number;
  /** ISO completedAt of the earliest order in this event. */
  firstOrder: string;
  /** ISO completedAt of the latest order in this event. */
  lastOrder: string;
}

export interface EventsResponse {
  events: EventSummary[];
}

// ── Analytics summary ─────────────────────────────────────────────────────────

export interface TopItem {
  itemId: string;
  name: string;
  qtyTotal: number;
  revenue: number;
}

export interface AnalyticsSummary {
  totalOrders: number;
  /** Sum of all item.qty values across every order in the filtered period. */
  totalItems: number;
  avgItemsPerOrder: number;
  /** Top items sorted by qty served (up to 10). */
  topItems: TopItem[];
  /** One entry per modifier group, options sorted by count desc. */
  modifierBreakdown: ModifierGroupStat[];
  /** Kept for reference but de-emphasised in the UI. */
  totalRevenue: number;
}

// ── Order history ─────────────────────────────────────────────────────────────

export interface AnalyticsOrdersResponse {
  orders: Order[];
  count: number;
}
