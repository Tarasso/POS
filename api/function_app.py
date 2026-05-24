import json
import azure.functions as func

from menu_routes import menu_bp
from order_routes import order_bp

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)
app.register_blueprint(menu_bp)
app.register_blueprint(order_bp)


@app.route(route="health", methods=["GET"])
def health(req: func.HttpRequest) -> func.HttpResponse:
    """Phase 0 health-check — verifies the Functions runtime is wired up."""
    return func.HttpResponse(
        json.dumps({"status": "ok"}),
        status_code=200,
        mimetype="application/json",
    )
