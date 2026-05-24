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

## Phase 0 Outcomes

### Versions installed
- **Angular CLI**: 21.2.12 (latest, not 17 — see naming changes below)
- **Node.js**: 24.16.0 LTS
- **Python**: 3.11.9 (installed alongside system Python 3.13; Functions venv uses 3.11)
- **Azure Functions Core Tools**: 4.12.0-preview.1 (installed via winget MSI, not npm)
- **SWA CLI**: 2.0.9

### Azure resources (all in `centralus` / region `Central US`)
| Resource | Name |
|---|---|
| Resource group | `rg-pos` |
| Cosmos DB (free tier) | `cosmos-pos-kylem` — DB: `pos_db`, containers: `menu`, `orders` |
| SignalR (serverless) | `signalr-pos-kylem` |
| Static Web App | `swa-pos-kylem` — https://calm-bay-05dda0610.7.azurestaticapps.net |

### Angular 21 naming changes (deviation from plan)
Angular CLI 21 drops `.component` from all generated filenames. This affects every future `ng g c` command:
- Files: `order.ts` / `order.html` / `order.scss` (not `order.component.*`)
- Class names: `Order`, `Kds`, `Admin`, `Analytics` (not `OrderComponent` etc.)
- Lazy-load imports: `import('./features/order/order').then(m => m.Order)`
- Static assets live in `public/` (not `src/assets/`) — icons at `public/icons/`

### Gotchas
1. **South Central US had no Cosmos DB capacity** — fell back to Central US.
2. **`swa deploy` CLI wrapper is broken on Windows (v2.0.9).** Call the binary directly:
   ```powershell
   $bin = "C:\Users\kylem\.swa\deploy\08e29138cd3dcda4ffda6d587aa580028110c1c7\StaticSitesClient.exe"
   & $bin upload --workdir . --app "dist/pos/browser" --api "api" `
     --apiToken <token> --skipAppBuild true --skipApiBuild true
   ```
3. **`--skipApiBuild true` is required** — Oryx (the API build tool inside StaticSitesClient) is Linux-only and crashes on Windows. Azure installs Python packages server-side from `requirements.txt`.
4. **`func start` needs the Python 3.11 venv in PATH** — system default is 3.13, which the Functions runtime rejects. Run from `/api` with:
   ```powershell
   $env:PATH = "C:\Users\kylem\OneDrive\Desktop\POS\api\.venv\Scripts;" + $env:PATH
   func start
   ```

## Phase 1 Outcomes

### What was built
- **`api/cosmos_helper.py`** — singleton Cosmos client, `get_menu_container()` / `get_orders_container()`
- **`api/menu_routes.py`** — Blueprint with 6 endpoints (GET menu, POST/PUT categories, POST/PUT items, PATCH soldout)
- **`api/seed_menu.py`** — idempotent standalone seed script (3 categories, 7 items)
- **`src/app/core/models/menu.models.ts`** — `Category`, `MenuItem`, `CategoryWithItems`, `MenuTree` interfaces
- **`src/app/core/services/menu.service.ts`** — signals-based service wrapping all 6 API calls
- **`src/app/features/admin/`** — full admin UI: inline add/edit forms per category and item, sold-out toggle

### Phase 1 Gotchas
5. **`func start` (v4.12 preview) always uses its bundled Python 3.13 worker**, ignoring the venv Python 3.11 in PATH when invoked non-interactively. For local dev, also install `azure-cosmos` into system Python 3.13:
   ```powershell
   & "C:\Program Files\Python313\python.exe" -m pip install azure-cosmos
   ```
   The deploy to Azure is unaffected — Azure uses Python 3.11 per `staticwebapp.config.json`.
6. **Route params must be read via `req.route_params.get("id")`** — the bundled Python 3.13 worker rejects route-param names declared as function parameters (e.g. `def f(req, id: str)`). Use `id = req.route_params.get("id", "")` inside the function body instead.
7. **Angular 17+ built-in control flow (`@if`, `@for`) makes `NgIf`/`NgFor` imports unnecessary** — importing them causes compiler warnings. Omit them from `standalone: true` component `imports` arrays when using block syntax.

## Commands
- `npm start` — Angular dev server
- `func start` — Functions locally (run from `/api`, see gotcha #4 and #5 above)
- `swa start` — full local stack via Static Web Apps CLI
- `npm run build` — production build
- `swa deploy` — **broken on Windows**; use StaticSitesClient.exe directly (see gotcha #2)

## Not in Scope
- Tax, payments, multi-tenant, user auth (v1), push notifications, order editing
- Only two order states ever exist: "open" and "completed"