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
DELETE /api/menu/categories/{id}                → delete category + all its items
POST   /api/menu/items                          → create item
PUT    /api/menu/items/{id}                     → update item
PATCH  /api/menu/items/{id}/soldout             → toggle sold out
DELETE /api/menu/items/{id}                     → delete item

POST   /api/menu/modifier-groups                → create modifier group
PUT    /api/menu/modifier-groups/{id}           → update modifier group
DELETE /api/menu/modifier-groups/{id}           → delete group + all options + unassign from items
PATCH  /api/menu/modifier-groups/{id}/items     → bulk assign/unassign items { add:[...], remove:[...] }
POST   /api/menu/modifier-options               → create modifier option
PUT    /api/menu/modifier-options/{id}          → update modifier option
DELETE /api/menu/modifier-options/{id}          → delete modifier option

GET    /api/orders?status=open                  → list orders by status
GET    /api/orders?status=completed             → list completed orders (newest-first)
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
- **Phase 5**: ✅ Polish — PWA dual-manifest install, safe-area CSS, error recovery affordances, SW update + offline banners

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
- 3-view flow: `menu` (category tiles) → `category` (item tiles) → `modifiers` (pill buttons per group)
- Items without modifier groups add directly to cart; items with groups open the modifier view
- Modifier groups enforce `minSelections` (Add to Cart disabled until met); `maxSelections: 1` = radio behaviour; `null` = unlimited multi-select
- Default options pre-selected on open; `allowsCustomText` options reveal an inline text input
- Cart lines keyed by `cartLineId` — same item with different modifiers stays separate
- Cart shows a modifier summary line per item (e.g. *Iced · Oat Milk · Vanilla*)
- Success overlay on order placed; resets to menu view
- **Note**: the original `cart` view was replaced by bottom sheets in a post-Phase-5 redesign — see Post-Phase 5 Improvements

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

## Phase 5 Outcomes

### What was built

**PWA install improvements**
- **`public/manifest.webmanifest`** — `theme_color` updated to `#1e293b` (matches dark nav bar); `start_url` changed to `/order`; name/short_name changed to "POS – Order" / "Order"
- **`public/manifest-kds.webmanifest`** — new manifest for iPad KDS install: `start_url: "/kds"`, name "POS – KDS" / "KDS", same icons
- **`src/app/features/kds/kds.ts`** — injects `DOCUMENT`; on `ngOnInit` swaps `<link rel="manifest">` to `manifest-kds.webmanifest`; on `ngOnDestroy` restores the default manifest. This means "Add to Home Screen" from the `/kds` route creates an iPad PWA that launches straight at `/kds`.
- **`src/index.html`** — added `viewport-fit=cover` to viewport meta so content fills edge-to-edge on notched iPhones (required for `black-translucent` status bar)
- **`src/app/app.ts`** — nav bar height and `app-content` padding-top both use `calc(2.75rem + env(safe-area-inset-top, 0px))` so the nav never overlaps the status bar on notched devices; falls back gracefully to `0px` on older devices/browsers

**Error recovery affordances**
- **`src/app/features/order/order.html`** — menu-load error banner now includes a **Retry** button
- **`src/app/features/order/order.ts`** — added `retryLoadMenu()` that calls `menuService.loadMenu()`
- **`src/app/features/order/order.scss`** — added `.error-banner-with-action` (flex row) and `.btn-text-action` (outlined inline button)
- **`src/app/features/kds/kds.html`** — "Connection lost" status bar now includes a **Reconnect** button
- **`src/app/features/kds/kds.ts`** — added `reconnect()` method: calls `disconnect()` then `connect()` for a clean restart
- **`src/app/features/kds/kds.scss`** — `.kds-status-bar` is now `display: flex; justify-content: space-between`; added `.reconnect-btn` style

**Admin silent-failure fix**
- **`src/app/features/admin/admin.ts`** — added `saveError = signal<string | null>(null)`; all 9 save/delete callbacks now set this signal on error (previously they silently reset `saving` with no user feedback); each attempt clears the previous error
- **`src/app/features/admin/admin.html`** — `@if (saveError())` banner rendered below the menu-load error banner

**PWA reliability**
- **`src/app/app.ts`** — subscribes to `SwUpdate.versionUpdates` (production only, guarded by `swUpdate.isEnabled`); shows a blue "↻ App updated — tap to refresh" banner on `VersionReadyEvent`; `applyUpdate()` calls `activateUpdate()` then reloads
- **`src/app/app.ts`** — listens to `window` `online`/`offline` events via `fromEvent` + `takeUntilDestroyed`; shows an amber "You're offline — orders can't be placed" banner; clears automatically when network returns

### Phase 5 Gotchas

19. **Dynamic manifest swap must happen in `ngOnInit`/`ngOnDestroy`** — the browser reads `<link rel="manifest">` at install time, not at page load. Swapping the href client-side when the user lands on `/kds` is sufficient because iOS only reads the manifest when "Add to Home Screen" is tapped.
20. **`env(safe-area-inset-top)` with `padding` shorthand breaks the nav** — the `.app-nav` already used `padding: 0 1rem` shorthand. Adding `padding-top: env(...)` after the shorthand would be overridden. Fix: use `padding-left`/`padding-right`/`padding-top` longhand properties separately.
21. **`SwUpdate` is `null` in dev mode** — `swUpdate.isEnabled` returns `false` when the service worker is not registered (local dev). Always guard SW code with `if (swUpdate.isEnabled)` to avoid runtime errors.
22. **`withAutomaticReconnect()` exhausts its retry budget after ~2 minutes of failure** — after that the hub enters a permanently `Disconnected` state and `onclose` fires. The manual Reconnect button handles this case by calling `disconnect()` (nulls `hubConnection`) then `connect()` to start a fresh connection.

## Post-Phase 5 Improvements

### Admin — delete + reorder

**API (`api/menu_routes.py`)**
- `DELETE /api/menu/categories/{id}` — deletes the category doc and every item whose `categoryId` matches (cascade). Returns `{"ok": true}`.
- `DELETE /api/menu/items/{id}` — deletes a single item. Returns `{"ok": true}`.

**Service (`src/app/core/services/menu.service.ts`)**
- `deleteItem(id)` — HTTP DELETE, then `loadMenu()` to refresh the signal.
- `deleteCategory(id)` — HTTP DELETE, then `loadMenu()`.
- `updateMenuItemOrder(catId, reorderedItems)` — optimistic local signal update for instant drag feedback.
- `reorderItems(updates[])` — fires parallel PUT calls via `forkJoin`, then `loadMenu()`.

**Admin UI (`src/app/features/admin/`)**
- Tab navigation: **Menu** tab (categories + items) and **Modifiers** tab (groups + options). `activeTab` signal switches between them.
- Delete category button on each category header — `confirm()` dialog warns about cascaded item deletion.
- Delete item button — `confirm()` dialog per item.
- Drag-and-drop item reordering within a category: HTML5 `draggable`, `dragstart`/`dragover`/`drop`/`dragend` handlers. Visual highlight on drag target. On drop, calls `reorderItems()` which PUTs new `sortOrder` values in parallel.
- Inline `addItemError` signal shows validation errors (name required, price required) without the global `saveError` banner.
- Auto-assigned `sortOrder` on new items (appended after last item in the category).

### KDS — modifier pills, double-tap, completed history

**KDS service (`src/app/core/services/kds.service.ts`)**
- New signals: `completedOrders`, `loadingCompleted`, `completedError`.
- `loadCompletedOrders()` — fetches `GET /api/orders?status=completed`, sorts newest-first by `completedAt`.

**KDS component (`src/app/features/kds/`)**
- **Modifier pills**: modifiers rendered as blue pill badges (`background: #dbeafe; color: #1e40af`) in a flex-wrap row instead of small gray list items — more legible at a glance.
- **Double-tap to complete**: the Done button is removed. Cards have `touch-action: manipulation` (eliminates iOS 300 ms double-tap delay) and listen to `(dblclick)`. A `(touchstart)` handler sets a `firstTapped` signal so the card's hint text changes to "Tap again to complete!" for 450 ms, then reverts to "Double-tap to complete". A `firstTapTimers` map holds cleanup `setTimeout` handles cleared in `ngOnDestroy`.
- **Completed history panel**: a fixed FAB button (bottom-right, dark slate) labelled "✓ History". Tapping opens a slide-in panel from the right showing completed orders (customer name, date/time, items with modifier pills, total). Panel has a ↻ Refresh button. `DatePipe` imported in the component for `| date:'M/d · h:mm a'` formatting.

### Order flow — two-button action bar + bottom sheets

The `cart` view type is removed. Cart editing and order submission are now driven by two persistent bottom-fixed buttons and two bottom sheets.

**Action bar** (shown on `menu` and `category` views when `cartCount() > 0`; hidden on `modifiers` view):
- **Left — cart preview button** (`.cart-peek-btn`): shows a blue count badge + item label + total. Opens the cart preview sheet.
- **Right — Place Order button** (`.place-order-btn`, green): opens the name prompt sheet. Takes remaining width.
- `padding-bottom: max(0.75rem, env(safe-area-inset-bottom))` so it sits above the iPhone home indicator.

**Cart preview sheet** (`.cart-sheet`):
- Bottom sheet, slides up, max-height 75dvh.
- Full item list with `+/−` qty controls and ✕ remove per line, plus a total row.
- Backdrop tap or ✕ dismisses.

**Name prompt sheet** (`.name-sheet`):
- Bottom sheet. Opening it calls `setTimeout(() => nameInputRef.focus(), 0)` — fires within the browser's user-gesture window so iOS triggers the soft keyboard.
- Single text input with `enterkeyhint="done"` and `(keydown.enter)="submitFromNamePrompt()"` — user can submit without touching the button.
- Green **Place Order — $X.XX** button shows the running total and disables while `canSubmit()` is false.
- Submit error shown inline inside the sheet.
- Sheet stays open while the HTTP request is in-flight; success overlay covers everything on success. `startNewOrder()` closes both sheets and resets all state.

**Angular budget** (`angular.json`): `anyComponentStyle` budget raised from `4kB warning / 8kB error` to `8kB warning / 16kB error` to accommodate the larger component SCSS files.

### Post-Phase 5 Gotchas

23. **iOS soft keyboard — use `ChangeDetectorRef.detectChanges()` + immediate `focus()`** — `setTimeout(..., 0)` is unreliable; iOS Safari closes the gesture-trust window before the macrotask fires. The correct pattern: inject `ChangeDetectorRef`, call `this.cdr.detectChanges()` immediately after setting the signal that renders the input, then call `.focus()` synchronously. This forces Angular to render the template in the same gesture tick so the element is in the DOM before focus is called. Applied in `openNamePrompt()` in `order.ts`.
24. **`touch-action: manipulation` enables `dblclick` on touch screens** — this CSS property disables the browser's double-tap-to-zoom gesture, which also removes the 300 ms click delay. With it, iOS/Android fires `dblclick` immediately on two quick taps, identical to a mouse double-click. Set it on any element that needs `(dblclick)` to work at full speed on touch devices.
25. **HTML5 drag-and-drop does not fire on iOS Safari** — the drag-and-drop item reorder in the admin UI uses the HTML5 Drag-and-Drop API, which is not supported on iOS/iPadOS without a polyfill. This is acceptable since the admin UI is used on desktop/Mac. If mobile admin editing is ever needed, replace with pointer-event-based drag logic.
26. **`forkJoin` with an empty array resolves immediately** — `forkJoin([])` completes synchronously with `[]`. This is fine for the reorder path but means the `.tap(() => loadMenu())` still fires even when no reorder calls were made.

## UI Polish — Responsive Order Screen + Color System

### Responsive order screen

- **Category tile grid** (`.category-tile-grid`) — 1 column on `max-width: 430px`. Item tiles within a category use the base `.tile-grid` which always stays 2 columns. The two grids share `.tile` styles but have independent column rules.
- **Action bar stacking** — at `≤ 430px` the cart-peek and Place Order buttons stack vertically (each full-width). A CSS custom property `--bar-h` on `.order-page` tracks the action bar height and is updated in the same media query:
  - Horizontal: `calc(4rem + max(0.75rem, env(safe-area-inset-bottom, 0.75rem)))`
  - Vertical (stacked): `calc(7.875rem + max(0.75rem, env(safe-area-inset-bottom, 0.75rem)))`

### Cart preview sheet — floats above action bar

The cart sheet (`.cart-sheet`) is positioned with `bottom: var(--bar-h)` so it slides up from just above the action bar and never covers the cart-peek or Place Order buttons. The cart-specific backdrop (`.cart-backdrop`) also stops at `bottom: var(--bar-h)` so taps on the action bar pass through. The name sheet (`.name-sheet`) intentionally stays at `bottom: 0` and covers the action bar (you're done browsing at that point).

The cart-peek button calls `toggleCartPreview()` (`showCartPreview.update(v => !v)`) — a second tap collapses the preview without needing to reach the ✕ button.

### Color system

All color fields are optional hex strings (e.g. `"#ef4444"`). Empty string or `null` means no custom color.

**Where colors live:**
- `Category.color?` — tile background on the order screen menu view
- `MenuItem.color?` — tile background on the order screen category view
- `ModifierOption.color?` — KDS modifier pill background; snapshotted into `AppliedModifier.color?` at order-placement time so the KDS always shows the color that was active when the order was placed

**Admin UI** — every add/edit form for categories, items, and modifier options has a "Tile color" / "KDS pill color" checkbox. When checked, a native `<input type="color">` picker appears with the current hex shown alongside. Unchecking sends `""` which the API converts to `null`. The modifier option read-only list shows a small color dot swatch when a color is set.

**Order screen tiles** — `[style.background]="item.color || null"` and `[style.border-color]="item.color ? 'transparent' : null"`. Light-colored tiles look best; dark tiles may need the default dark text replaced (not currently auto-detected on the order screen — pick light/pastel shades).

**KDS pills** — `kds.ts` has `modPillStyle()` / `modPillTextColor()` using ITU-R BT.601 perceived luminance:
```typescript
const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
return lum > 0.55 ? '#1a1a1a' : '#ffffff';
```
Colored pills get the custom background, auto-contrast text, and a transparent border. Both live-order pills and the completed-history panel pills receive the same treatment.

**Current KDS pill colors (set directly in Cosmos):**
| Option | Color | Hex |
|--------|-------|-----|
| Hot | Red | `#ef4444` |
| Oat Milk | Amber | `#f59e0b` |

**API changes** — `color` field handled in: `POST/PUT /api/menu/categories`, `POST/PUT /api/menu/items`, `POST/PUT /api/menu/modifier-options`. Pattern: `existing["color"] = body["color"] or None`.

**Utility script** — `api/set_option_colors.py` queries all modifier options by name (case-insensitive) and upserts colors. Safe to re-run. Extend `COLOR_MAP` dict to add more options:
```python
COLOR_MAP: dict[str, str] = {
    "hot":      "#ef4444",
    "oat milk": "#f59e0b",
}
```
Run with: `& "C:\Program Files\Python313\python.exe" api\set_option_colors.py`

### Post-UI-Polish Gotchas

27. **`--bar-h` CSS variable must be updated in every breakpoint that changes the action bar height** — the variable is defined on `.order-page` and overridden in the `≤430px` media query. If you add another breakpoint or change button heights, update both the action bar layout AND `--bar-h`. Failing to do so causes the cart sheet to overlap the bar.
28. **`AppliedModifier.color` is a snapshot, not a live lookup** — changing a modifier option's color in the admin has no effect on orders already placed. Only new orders pick up the new color. This is intentional: consistent with how `optionName` is already snapshotted.
29. **Windows terminal encoding** — `api/set_option_colors.py` avoids non-ASCII characters in print statements to prevent `cp1252` encoding errors on Windows PowerShell. Keep print strings ASCII-only in all Python scripts.

## Not in Scope
- Tax, payments, multi-tenant, push notifications, order editing
- Only two order states ever exist: "open" and "completed"