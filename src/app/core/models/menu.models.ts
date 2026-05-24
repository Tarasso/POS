/** Mirrors the Cosmos 'category' document shape (partition key: /type). */
export interface Category {
  id: string;
  type: 'category';
  name: string;
  parentId: string | null;
  sortOrder: number;
}

/** Mirrors the Cosmos 'item' document shape (partition key: /type). */
export interface MenuItem {
  id: string;
  type: 'item';
  name: string;
  categoryId: string;
  price: number;
  soldOut: boolean;
  sortOrder: number;
}

/** A category with its items already nested (returned by GET /api/menu). */
export interface CategoryWithItems extends Category {
  items: MenuItem[];
}

/** Top-level shape of GET /api/menu response. */
export interface MenuTree {
  categories: CategoryWithItems[];
}
