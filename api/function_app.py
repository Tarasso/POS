import json
import azure.functions as func

from analytics_routes import analytics_bp
from menu_routes import menu_bp
from order_routes import order_bp
from signalr_helper import get_client_connection_info

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)
app.register_blueprint(menu_bp)
app.register_blueprint(order_bp)
app.register_blueprint(analytics_bp)


@app.route(route="health", methods=["GET"])
def health(req: func.HttpRequest) -> func.HttpResponse:
    """Phase 0 health-check — verifies the Functions runtime is wired up."""
    return func.HttpResponse(
        json.dumps({"status": "ok"}),
        status_code=200,
        mimetype="application/json",
    )


# ── SignalR negotiate ──────────────────────────────────────────────────────────
# The @microsoft/signalr HubConnectionBuilder POSTs to /api/negotiate
# (it appends "/negotiate" to the base URL — ".withUrl('/api')" → POST /api/negotiate).
# We generate the { url, accessToken } payload manually so this works identically
# in local func start and in Azure — no extension binding required.

@app.route(route="negotiate", methods=["POST"])
def negotiate(req: func.HttpRequest) -> func.HttpResponse:
    """Return Azure SignalR client connection info for the KDS hub."""
    try:
        info = get_client_connection_info()
        return func.HttpResponse(
            json.dumps(info),
            status_code=200,
            mimetype="application/json",
        )
    except Exception as exc:
        import logging
        logging.getLogger(__name__).exception("negotiate failed: %s", exc)
        return func.HttpResponse(
            json.dumps({"error": "SignalR negotiate failed."}),
            status_code=500,
            mimetype="application/json",
        )
