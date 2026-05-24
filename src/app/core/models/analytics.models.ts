import { Order } from './order.models';

export interface TopItem {
  itemId: string;
  name: string;
  qtyTotal: number;
  revenue: number;
}

export interface DailyRevenue {
  /** ISO date string "YYYY-MM-DD" */
  date: string;
  revenue: number;
  orders: number;
}

export interface AnalyticsSummary {
  totalOrders: number;
  totalRevenue: number;
  avgOrderValue: number;
  topItems: TopItem[];
  revenueByDay: DailyRevenue[];
}

export interface AnalyticsOrdersResponse {
  orders: Order[];
  count: number;
}
