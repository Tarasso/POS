/** A drink on a Ticket Counter event. */
export interface CounterItem {
  id: string;
  name: string;
}

/** A Ticket Counter event: prepaid-ticket drinks tallied per station. */
export interface CounterEvent {
  id: string;
  name: string;
  stationCount: number;
  active: boolean;
  createdAt: string;
  items: CounterItem[];
  /** Only on GET /api/counter/events. */
  totalCount?: number;
}

/** Count of one drink at one station. */
export interface CounterTally {
  station: number;
  itemId: string;
  itemName: string;
  count: number;
}

/** GET /api/counter/active and GET /api/counter/events/{id}/results */
export interface CounterSnapshot {
  event: CounterEvent | null;
  tallies: CounterTally[];
}

/** Body for creating/updating an event. Items without an id are new. */
export interface CounterEventPayload {
  name?: string;
  stationCount?: number;
  active?: boolean;
  items?: { id?: string; name: string }[];
}
