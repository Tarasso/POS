# POS + KDS

A PWA Point of Sale and Kitchen Display System. Built with Angular 21, Azure Functions (Python), Cosmos DB, and Azure Static Web Apps.

**Live URL**: https://calm-bay-05dda0610.7.azurestaticapps.net

---

## Running locally

Three terminals are required. Start them in order and wait for each to be ready before moving to the next.

> **First time only:** if `npm` or `swa` are not recognized, prepend this to `$env:PATH` in each terminal:
> ```powershell
> $env:PATH = "C:\Program Files\nodejs;C:\Users\kylem\AppData\Roaming\npm;" + $env:PATH
> ```

### Terminal 1 — API (Azure Functions)

```powershell
& "C:\Program Files\Microsoft\Azure Functions Core Tools\func.exe" start --script-root "C:\Users\kylem\OneDrive\Desktop\POS\api"
```

Wait until you see: `get_menu: [GET] http://localhost:7071/api/menu`

### Terminal 2 — Angular dev server

```powershell
$env:PATH = "C:\Program Files\nodejs;C:\Users\kylem\AppData\Roaming\npm;" + $env:PATH
cd C:\Users\kylem\OneDrive\Desktop\POS
npm start
```

Wait until you see: `Local: http://localhost:4200/`

### Terminal 3 — SWA proxy

```powershell
$env:PATH = "C:\Program Files\nodejs;C:\Users\kylem\AppData\Roaming\npm;" + $env:PATH
cd C:\Users\kylem\OneDrive\Desktop\POS
swa start http://localhost:4200 --api-devserver-url http://localhost:7071
```

Wait until you see: `Serving from: http://localhost:4280`

### Browse

| URL | Page |
|---|---|
| http://localhost:4280/admin | Menu management (fully working) |
| http://localhost:4280/order | Order taking (Phase 2) |
| http://localhost:4280/kds | Kitchen display (Phase 3) |

> Use **port 4280**, not 4200. Only 4280 proxies `/api/*` calls to the Functions.

---

## Deploying to Azure

```powershell
# 1. Bundle Python packages (required before every deploy)
& "C:\Program Files\Python313\python.exe" -m pip install -r api\requirements.txt --target api\.python_packages\lib\site-packages

# 2. Build Angular
$env:PATH = "C:\Program Files\nodejs;" + $env:PATH
npm run build

# 3. Upload to Azure
$bin = "C:\Users\kylem\.swa\deploy\08e29138cd3dcda4ffda6d587aa580028110c1c7\StaticSitesClient.exe"
& $bin upload --workdir . --app "dist/pos/browser" --api "api" `
  --apiToken <your-token> --skipAppBuild true --skipApiBuild true --configFileLocation "."
```

See `CLAUDE.md` for the full deployment token and troubleshooting notes.
