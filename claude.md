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
    {
      "itemId": "item_latte", "name": "Latte", "price": 5.50, "qty": 1,
      "modifiers": [
        { "groupId": "mgrp_...", "groupName": "Drink Type", "optionId": "mopt_...", "optionName": "Iced" },
        { "groupId": "mgrp_...", "groupName": "Milk Type",  "optionId": "mopt_...", "optionName": "Oat Milk" }
      ]
    }
  ],
  "total": 5.50,
  "createdAt": "2026-05-23T14:32:00Z",
  "completedAt": null
}
```

### `menu` container — modifier documents

Modifier group (partition key: `modifier_group`):
```json
{
  "id": "mgrp_abc12345",
  "type": "modifier_group",
  "name": "Drink Type",
  "minSelections": 1,
  "maxSelections": 1,
  "sortOrder": 1
}
```
`maxSelections: null` means unlimited.

Modifier option (partition key: `modifier_option`):
```json
{
  "id": "mopt_abc12345",
  "type": "modifier_option",
  "groupId": "mgrp_abc12345",
  "name": "Iced",
  "isDefault": false,
  "allowsCustomText": false,
  "sortOrder": 1
}
```
Options with `allowsCustomText: true` reveal a free-text input when selected (e.g. "Custom Instructions").

`MenuItem` documents also gain:
```json
{ "modifierGroupIds": ["mgrp_abc12345", "mgrp_def67890"] }
```
Defaults to `[]` — backward-compatible with seeded items that predate this field.

**Important**: Cosmos doesn't allow updating a document's partition key in place. When an order moves from "open" to "completed", delete the original doc and insert a new one with `status: "completed"` and `completedAt` set.

## API Endpoints

```
GET    /api/menu                                → full menu tree + modifier groups
POST   /api/menu/categories                     → create category
PUT    /api/menu/categories/{id}                → update category
POST   /api/menu/items                          → create item
PUT    /api/menu/items/{id}                     → update item
PATCH  /api/menu/items/{id}/soldout             → toggle sold out

POST   /api/menu/modifier-groups                → create modifier group
PUT    /api/menu/modifier-groups/{id}           → update modifier group
DELETE /api/menu/modifier-groups/{id}           → delete group + all options + unassign from items
PATCH  /api/menu/modifier-groups/{id}/items     → bulk assign/unassign items { add:[...], remove:[...] }
POST   /api/menu/modifier-options               → create modifier option
PUT    /api/menu/modifier-options/{id}          → update modifier option
DELETE /api/menu/modifier-options/{id}          → delete modifier option

GET    /api/orders?status=open                  → list orders by status
POST   /api/orders                              → create order
PATCH  /api/orders/{id}/complete                → mark completed (create-before-delete across partitions + SignalR broadcast)

GET    /api/analytics/summary                   → aggregate stats
GET    /api/analytics/orders                    → historical orders

POST   /api/negotiate                           → SignalR connection handshake
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
- Authentication: SWA built-in auth (Entra ID / Microsoft), invitation-based role assignment (`staff`, `owner`). See **Security** section below.

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

- **Phase 0**: ✅ Scaffolding — Angular + `@angular/pwa`, Functions Python app, Azure resources created, hello world deployed
- **Phase 1**: ✅ Menu management — Cosmos schema, menu CRUD API, admin UI, sold-out toggle
- **Phase 2**: ✅ Order taking — category tiles → item tiles → modifier selection → cart → order POST; modifier system (groups/options CRUD + bulk assignment); global nav bar
- **Phase 3**: ✅ KDS — SignalR setup, order cards, live timer, complete action
- **Phase 4**: ✅ Analytics — aggregation queries, dashboard
- **Phase 5**: Polish — real-device PWA install testing, empty states, error handling

> **Auth** (shipped between Phase 4 and 5): SWA built-in auth with Entra ID (Microsoft). Role-based access via Azure Portal invitations. See **Security** section.

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
2. **`swa deploy` CLI wrapper is broken on Windows (v2.0.9).** Call the binary directly. **`--configFileLocation "."` is required** so the tool finds `staticwebapp.config.json` and knows the API runtime is Python 3.11 — omitting it causes "Function language info isn't provided" error:
   ```powershell
   $bin = "C:\Users\kylem\.swa\deploy\08e29138cd3dcda4ffda6d587aa580028110c1c7\StaticSitesClient.exe"
   & $bin upload --workdir . --app "dist/pos/browser" --api "api" `
     --apiToken <token> --skipAppBuild true --skipApiBuild true --configFileLocation "."
   ```
3. **`--skipApiBuild true` is required AND packages must be pre-bundled.** Oryx is Linux-only and crashes on Windows. Azure does NOT auto-install from `requirements.txt` when the build is skipped — the API gets a 404 on all routes if packages are missing. Before every deploy, run:
   ```powershell
   & "C:\Program Files\Python313\python.exe" -m pip install -r api\requirements.txt `
     --target api\.python_packages\lib\site-packages
   ```
   `api/.python_packages/` is gitignored but StaticSitesClient.exe zips from the filesystem so it's included in the upload. When you add a new package to `requirements.txt`, re-run this before deploying.
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

## Phase 2 Outcomes

### What was built

**API**
- **`api/order_routes.py`** — new Blueprint registered in `function_app.py`; `GET /api/orders?status=`, `POST /api/orders`, `PATCH /api/orders/{id}/complete` (501 stub for Phase 3)
- **`api/menu_routes.py`** — 8 new endpoints for modifier group/option CRUD and bulk item assignment; `GET /api/menu` now returns `modifierGroups` alongside `categories`

**Frontend models**
- **`src/app/core/models/order.models.ts`** — `CartItem` (with `cartLineId` + `modifiers[]`), `OrderLineItem`, `Order`, `AppliedModifier`, `CreateOrderPayload`
- **`src/app/core/models/menu.models.ts`** — updated: `ModifierGroup`, `ModifierOption`, `ModifierGroupWithOptions`; `MenuItem` gains `modifierGroupIds: string[]`; `MenuTree` gains `modifierGroups`

**Frontend services**
- **`src/app/core/services/order.service.ts`** — cart signals (`cart`, `customerName`, `submitting`, `lastSubmittedOrder`), computed (`cartCount`, `cartTotal`, `canSubmit`), `addItem` always appends a new `cartLineId` line, `submitOrder` POSTs with modifiers
- **`src/app/core/services/menu.service.ts`** — updated with modifier CRUD and `assignModifierGroup` methods

**Order UI** (`src/app/features/order/`)
- 4-view flow: `menu` (category tiles) → `category` (item tiles) → `modifiers` (pill buttons per group) → `cart`
- Items without modifier groups add directly to cart; items with groups open the modifier view
- Modifier groups enforce `minSelections` (Add to Cart disabled until met); `maxSelections: 1` = radio behaviour; `null` = unlimited multi-select
- Default options pre-selected on open; `allowsCustomText` options reveal an inline text input
- Cart lines keyed by `cartLineId` — same item with different modifiers stays separate
- Cart shows a modifier summary line per item (e.g. *Iced · Oat Milk · Vanilla*)
- Success overlay on order placed; resets to menu view

**Admin UI** (`src/app/features/admin/`)
- New **Modifier Groups** section below category list
- Per-group: create/edit/delete the group (name, min, max selections, sort order)
- Per-option: create/edit/delete (name, default flag, custom-text flag)
- **Assign Items** panel: checklist of all items grouped by category; category-level checkbox with indeterminate state for partial selection; single **Apply** call to bulk-assign/unassign

**Global navigation** (`src/app/app.ts`)
- Fixed top nav bar (height `2.75rem`, dark slate `#1e293b`) with **POS** brand and links: Order · KDS · Admin · Analytics
- `routerLinkActive` highlights the current route
- `app-content` wrapper has `padding-top: 2.75rem`; order page sticky headers use `top: 2.75rem`

### Phase 2 Gotchas

8. **`[(ngModel)]` cannot bind directly to a signal** — bridge with a getter/setter pair on the component class: `get x() { return this.svc.x(); }` / `set x(v) { this.svc.x.set(v); }`.
9. **`CartItem.cartLineId` (not `itemId`) is the unique cart key** — each add-to-cart always creates a new line so different modifier combinations remain separate. `increment/decrement/remove` all use `cartLineId`.
10. **`ORDER BY c.createdAt DESC` may fail without a composite index** — `order_routes.py` catches the error and falls back to a Python `sorted()` call.
11. **`100dvh` not `100vh`** — iOS Safari's `100vh` includes the hidden URL bar. Use `100dvh` throughout the order page to avoid layout overflow.
12. **Global nav is `position: fixed`** — sticky elements inside page components must use `top: 2.75rem` (the nav height) not `top: 0`, or they slide under the nav bar on scroll.
13. **`[indeterminate]` on `<input type="checkbox">`** — Angular supports binding to this DOM property directly; no special import needed.

## Commands

### Local development (3 terminals required)

**Terminal 1 — API** (func.exe uses bundled Python 3.13 worker; azure-cosmos must be installed in system Python 3.13):
```powershell
& "C:\Program Files\Microsoft\Azure Functions Core Tools\func.exe" start --script-root "C:\Users\kylem\OneDrive\Desktop\POS\api"
```

**Terminal 2 — Angular dev server** (prepend nodejs to PATH first):
```powershell
$env:PATH = "C:\Program Files\nodejs;C:\Users\kylem\AppData\Roaming\npm;" + $env:PATH
cd C:\Users\kylem\OneDrive\Desktop\POS
npm start
```

**Terminal 3 — SWA proxy** (wait for Terminal 2 to be ready first; use 4280, not 4200):
```powershell
$env:PATH = "C:\Program Files\nodejs;C:\Users\kylem\AppData\Roaming\npm;" + $env:PATH
cd C:\Users\kylem\OneDrive\Desktop\POS
swa start http://localhost:4200 --api-devserver-url http://localhost:7071
```
Browse to **http://localhost:4280/admin**

### Deploy to Azure

```powershell
# 1. Bundle packages (required; Azure won't auto-install when --skipApiBuild is used)
& "C:\Program Files\Python313\python.exe" -m pip install -r api\requirements.txt --target api\.python_packages\lib\site-packages

# 2. Build
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH
npm run build

# 3. Upload
$bin = "C:\Users\kylem\.swa\deploy\08e29138cd3dcda4ffda6d587aa580028110c1c7\StaticSitesClient.exe"
& $bin upload --workdir . --app "dist/pos/browser" --api "api" `
  --apiToken <token> --skipAppBuild true --skipApiBuild true --configFileLocation "."
```

## Phase 3 Outcomes

### What was built

**API**
- **`api/signalr_helper.py`** — new module; all SignalR logic in one place:
  - `get_client_connection_info()` — generates `{ url, accessToken }` for the KDS WebSocket client; token TTL 1 hour
  - `broadcast_order_created(order_doc)` / `broadcast_order_completed(order_id)` — POST to Azure SignalR Management REST API with a short-lived (30 s) JWT
  - `_parse_connection_string()` / `_make_token()` — shared helpers
- **`api/function_app.py`** — added `POST /api/negotiate`; calls `get_client_connection_info()` directly (no Azure Functions binding — see gotcha #14)
- **`api/order_routes.py`** — `complete_order` fully implemented: read from "open" partition → create in "completed" partition → delete from "open" → broadcast `orderCompleted`; `create_order` now calls `broadcast_order_created` after a successful Cosmos insert
- **`api/requirements.txt`** — added `PyJWT>=2.8.0`

**Frontend**
- **`src/app/core/services/kds.service.ts`** — new service; `orders`, `connectionState`, `completing` signals; `loadOrders()` (initial HTTP fetch), `connect()` / `disconnect()` (SignalR lifecycle with `withAutomaticReconnect`), `completeOrder()` (HTTP PATCH → remove from signal on success; SignalR `orderCompleted` event is idempotent)
- **`src/app/features/kds/kds.ts`** — full component; 1-second `tick` signal drives `elapsedDisplay()` ("3m 42s") and `urgencyClass()` without RxJS
- **`src/app/features/kds/kds.html`** — connection status bar, empty state, auto-fill card grid; each card: customer name, live timer, item + modifier list, Done button with in-flight loading state
- **`src/app/features/kds/kds.scss`** — 2-column `auto-fill` grid, urgency border/background at 8 min (yellow) and 15 min (red), 3.5 rem Done button for iPad touch targets

### Phase 3 Gotchas

14. **`signalRConnectionInfo` input binding does not work with the local Python 3.13 worker** — the bundled `func.exe` worker silently drops injected binding arguments (same root cause as gotcha #6). Implemented `negotiate` as a plain HTTP function that calls `signalr_helper.get_client_connection_info()` instead; this works identically locally and in Azure with no extension bundle dependency.
15. **`@microsoft/signalr` HubConnectionBuilder appends `/negotiate`** — pass `'/api'` as the base URL (`.withUrl('/api')`); the SDK will POST to `/api/negotiate` automatically. Do NOT pass `'/api/negotiate'` — that would POST to `/api/negotiate/negotiate`.
16. **Cosmos partition-key change on complete** — Cosmos does not allow in-place partition-key updates. The complete flow must create the new doc first (in the "completed" partition), then delete the old one (from "open"). If delete fails after create, the order exists in both partitions; acceptable for this low-volume app — log and return 200, clean up manually if needed.
17. **`signal<Set<string>>` requires a new Set reference** — Angular change detection compares by reference. Use `new Set([...s, id])` and `new Set(s)` with `.delete()` rather than mutating in place.
18. **SignalR broadcasts reach Azure directly from `func start`** — there is no local SignalR emulator. Broadcasts hit the real `signalr-pos-kylem.service.signalr.net` endpoint even during local development. The KDS Angular client also connects directly to Azure SignalR (the negotiate response contains the Azure URL); this goes through the client's network, not through the SWA CLI proxy.

## Phase 4 Outcomes

### What was built

**API**
- **`api/analytics_routes.py`** — new Blueprint registered in `function_app.py`; two endpoints:
  - `GET /api/analytics/summary` → queries all completed orders (partition `"completed"`), aggregates in Python: `totalOrders`, `totalRevenue`, `avgOrderValue`, top 5 items by qty, revenue by day (last 30 days)
  - `GET /api/analytics/orders` → completed order history sorted newest-first

**Frontend models**
- **`src/app/core/models/analytics.models.ts`** — `TopItem`, `DailyRevenue`, `AnalyticsSummary`, `AnalyticsOrdersResponse`

**Frontend service**
- **`src/app/core/services/analytics.service.ts`** — signals: `summary`, `orders`, `loading`, `error`; `loadAll()` fires both HTTP requests concurrently

**Analytics UI** (`src/app/features/analytics/`)
- Summary cards row: Total Orders · Total Revenue · Avg Order Value
- Top Items table: rank, item name, qty sold, revenue (top 5)
- Revenue by Day table: last 30 days, sorted newest-first
- Order History table: date, customer, item count, total; empty state if no completed orders
- Loading/error states; `CurrencyPipe` + `DatePipe` for formatting — no new packages

## Security

### SWA Built-in Auth (Entra ID / Microsoft)

Authentication is enforced at the **Azure CDN layer** — unauthenticated requests never reach Angular or Azure Functions.

**How it works:**
- `staticwebapp.config.json` protects `/*` and `/api/*` with `allowedRoles: ["staff", "owner"]`
- `/.auth/*` stays open to `anonymous` (login/logout/me endpoints must be reachable before auth)
- Any 401 auto-redirects to `/.auth/login/aad` (Microsoft sign-in)
- After sign-in, SWA sets a secure httpOnly cookie; user lands back on the app
- Sign Out link in the nav bar points to `/.auth/logout`

**Role management (Azure Portal):**
1. Azure Portal → `swa-pos-kylem` → Settings → **Authentication** — Entra ID and GitHub providers are pre-enabled in Simple mode
2. Azure Portal → `swa-pos-kylem` → Settings → **Role management** → **Invite**
   - Enter email, select provider (Entra ID), assign role (`staff` or `owner`)
   - Send the generated invitation link; it expires after 24 hours
   - Free Microsoft accounts (Outlook/Hotmail/Live) work — no work/school account required
3. To revoke: Role management → find user → Delete (takes effect immediately)

**Local dev:**
`swa start` serves a mock auth form at `http://localhost:4280/.auth/login/aad`. Fill in any name/email and type `staff` in the roles field. No real Microsoft account needed.

**Azure Functions `AuthLevel.ANONYMOUS` is intentional** — the SWA CDN blocks unauthenticated traffic before it ever reaches the function runtime. The auth level setting only affects direct Function URL access, which is not exposed here.

## Not in Scope
- Tax, payments, multi-tenant, push notifications, order editing
- Only two order states ever exist: "open" and "completed"