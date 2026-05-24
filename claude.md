# POS + KDS Project

## Purpose
A low-volume Point of Sale and Kitchen Display System for personal business use.
Used a few times per month. Optimize for simplicity and low maintenance over scale.

## Architecture
- **Frontend**: Angular 17+ PWA (standalone components, signals)
- **Backend**: Azure Functions (Python 3.11, v2 programming model)
- **Database**: Azure Cosmos DB (NoSQL API, free tier)
- **Real-time**: Azure SignalR Service (serverless mode, free tier)
- **Hosting**: Azure Static Web Apps (free tier) with integrated Functions

## Target Devices
- iPhone (order-taker UI, route: `/order`)
- iPad (KDS display, route: `/kds`)
- Both install the same PWA from different start URLs

## Repo Structure
```
/                          Angular app root
/src/app/core/             services, models
/src/app/features/order/   iPhone order-taker
/src/app/features/kds/     iPad display
/src/app/features/admin/   menu management
/src/app/features/analytics/  reporting
/api/                      Azure Functions Python app
/staticwebapp.config.json  SWA routing/auth config
CLAUDE.md                  this file
```

## Data Model

### `menu` container — partition key: `/type`

Category document:
```json
{
  "id": "cat_drinks",
  "type": "category",
  "name": "Drinks",
  "parentId": null,
  "sortOrder": 1
}
```

Item document:
```json
{
  "id": "item_latte",
  "type": "item",
  "name": "Latte",
  "categoryId": "cat_coffee",
  "price": 5.50,
  "soldOut": false,
  "sortOrder": 1
}
```

### `orders` container — partition key: `/status`

```json
{
  "id": "ord_abc123",
  "status": "open",
  "customerName": "Sarah",
  "items": [
    { "itemId": "item_latte", "name": "Latte", "price": 5.50, "qty": 1 }
  ],
  "total": 5.50,
  "createdAt": "2026-05-23T14:32:00Z",
  "completedAt": null
}
```

**Important**: Cosmos doesn't allow updating a document's partition key in place. When an order moves from "open" to "completed", delete the original doc and insert a new one with `status: "completed"` and `completedAt` set.

## API Endpoints

```
GET    /api/menu                    → full menu tree
POST   /api/menu/items              → create item
PUT    /api/menu/items/{id}         → update item
PATCH  /api/menu/items/{id}/soldout → toggle sold out
POST   /api/menu/categories         → create category
PUT    /api/menu/categories/{id}    → update category

GET    /api/orders?status=open      → list orders by status
POST   /api/orders                  → create order (broadcasts via SignalR)
PATCH  /api/orders/{id}/complete    → mark completed (broadcasts via SignalR)

GET    /api/analytics/summary       → aggregate stats
GET    /api/analytics/orders        → historical orders

POST   /api/negotiate               → SignalR connection handshake
```

## SignalR

- Hub name: `kds`
- Mode: serverless
- Events:
  - `orderCreated` → payload: full order object
  - `orderCompleted` → payload: `{ orderId }`
- Only the KDS UI subscribes. The order-taker UI does not connect to SignalR.

## Conventions
- Angular: standalone components, signals for state, RxJS only for SignalR stream
- Python: type hints required, `azure-functions` v2 programming model
- API responses: JSON, camelCase in API and frontend, also camelCase in DB (keep it consistent — no transformation layer)
- IDs prefixed by type: `cat_`, `item_`, `ord_`
- No authentication in v1 — add later via SWA built-in auth if needed

## Free Tier Constraints
- Only ONE Cosmos DB free-tier account per Azure subscription
- Cosmos: 1000 RU/s, 25 GB total
- SignalR Free: 20 concurrent connections, 20k messages/day — use serverless mode only
- Functions Consumption plan: 1M executions/month free
- Static Web Apps Free: 100 GB bandwidth/month
- Do NOT enable Application Insights without setting a $0 daily cap

## iOS PWA Notes
- Required meta tags: `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-touch-icon`
- iOS treats different start URLs as separate installed apps — that's how iPhone gets `/order` and iPad gets `/kds`
- iPad KDS: set Auto-Lock to Never (iOS Settings → Display)
- No push notifications — rely on SignalR while KDS app is open

## Development Phases
Build strictly in this order. Each phase ships working end-to-end before the next.

- **Phase 0**: Scaffolding — Angular + `@angular/pwa`, Functions Python app, Azure resources created, hello world deployed
- **Phase 1**: Menu management — Cosmos schema, menu CRUD API, admin UI, sold-out toggle
- **Phase 2**: Order taking — menu browser, cart, customer name, order POST
- **Phase 3**: KDS — SignalR setup, order cards, live timer, complete action
- **Phase 4**: Analytics — aggregation queries, dashboard
- **Phase 5**: Polish — real-device PWA install testing, empty states, error handling

Do not jump ahead.

## Commands
- `npm start` — Angular dev server
- `func start` — Functions locally (run from `/api`)
- `swa start` — full local stack via Static Web Apps CLI
- `npm run build` — production build
- `swa deploy` — deploy to Azure

## Not in Scope
- Tax, payments, multi-tenant, user auth (v1), push notifications, order editing
- Only two order states ever exist: "open" and "completed"