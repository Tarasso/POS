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
  /** IDs of modifier groups attached to this item. Defaults to [] if absent. */
  modifierGroupIds: string[];
}

/** A category with its items already nested (returned by GET /api/menu). */
export interface CategoryWithItems extends Category {
  items: MenuItem[];
}

/** A single selectable option within a modifier group. */
export interface ModifierOption {
  id: string;
  type: 'modifier_option';
  groupId: string;
  name: string;
  /** Pre-selected by default when the modifier view opens. */
  isDefault: boolean;
  /** When selected, reveals an inline text input for custom instructions. */
  allowsCustomText: boolean;
  sortOrder: number;
}

/** A logical grouping of modifier options (e.g. "Drink Type", "Flavors"). */
export interface ModifierGroup {
  id: string;
  type: 'modifier_group';
  name: string;
  /** Minimum number of selections required before the item can be added to cart. */
  minSelections: number;
  /** Maximum selections allowed. null = unlimited. */
  maxSelections: number | null;
  sortOrder: number;
}

/** A modifier group with its options already nested (returned by GET /api/menu). */
export interface ModifierGroupWithOptions extends ModifierGroup {
  options: ModifierOption[];
}

/** Top-level shape of GET /api/menu response. */
export interface MenuTree {
  categories: CategoryWithItems[];
  modifierGroups: ModifierGroupWithOptions[];
}
