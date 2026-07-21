from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .config import Settings, get_settings
from .execution import ActionGateway
from .policy import PolicyEngine
from .schemas import (
    ActionResponse,
    ControlResponse,
    ErrorResponse,
    HealthResponse,
    OperatorRequest,
    ReceiptPage,
    ResetStopRequest,
    StateResponse,
    StopRequest,
)
from .stop import StopController
from .storage import ReceiptStore

logger = logging.getLogger("switchyard")


def create_app(
    settings: Settings | None = None,
    *,
    store: ReceiptStore | None = None,
    gateway: ActionGateway | None = None,
) -> FastAPI:
    runtime = settings or get_settings()
    receipt_store = store or ReceiptStore(runtime.database_url)
    stop = gateway.stop if gateway is not None else StopController(runtime.initial_stop)
    action_gateway = gateway or ActionGateway(stop, PolicyEngine(), receipt_store)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        receipt_store.initialize()
        yield
        receipt_store.dispose()

    application = FastAPI(
        title=runtime.app_name,
        version="1.0.0",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    application.state.settings = runtime
    application.state.store = receipt_store
    application.state.gateway = action_gateway

    application.add_middleware(TrustedHostMiddleware, allowed_hosts=runtime.allowed_hosts)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=runtime.allowed_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Request-ID"],
        expose_headers=["X-Request-ID"],
        max_age=600,
    )

    @application.middleware("http")
    async def request_boundary(request: Request, call_next):  # type: ignore[no-untyped-def]
        request_id = uuid4().hex
        request.state.request_id = request_id
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                too_large = int(content_length) > runtime.max_content_length
            except ValueError:
                too_large = True
            if too_large:
                response = _error(413, "request.too-large", "Request body exceeds the local limit.", request_id)
            else:
                response = await call_next(request)
        else:
            response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    @application.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        return HealthResponse()

    @application.get("/api/state", response_model=StateResponse)
    async def state() -> StateResponse:
        return StateResponse(
            stop=action_gateway.stop.state,
            capabilities=["fixtures.read", "control.stop", "control.reset"],
            limitations=[
                "No network providers or live integrations are implemented.",
                "Voice input and output are not implemented.",
                "Receipts prove local processing metadata, not external-world truth.",
            ],
        )

    @application.get("/api/receipts", response_model=ReceiptPage)
    async def receipts() -> ReceiptPage:
        return ReceiptPage(receipts=receipt_store.recent(runtime.receipt_limit))

    @application.post(
        "/api/actions",
        response_model=ActionResponse,
        responses={403: {"model": ActionResponse}, 423: {"model": ActionResponse}},
    )
    async def actions(request: OperatorRequest):  # type: ignore[no-untyped-def]
        outcome = await action_gateway.execute(request)
        if outcome.receipt.status.value == "stopped":
            return JSONResponse(status_code=423, content=outcome.model_dump(mode="json"))
        if outcome.receipt.status.value == "blocked":
            return JSONResponse(status_code=403, content=outcome.model_dump(mode="json"))
        return outcome

    @application.post("/api/stop", response_model=ControlResponse)
    async def enable_stop(request: StopRequest) -> ControlResponse:
        return await action_gateway.enable_stop(request)

    @application.post("/api/stop/reset", response_model=ControlResponse)
    async def reset_stop(request: ResetStopRequest) -> ControlResponse:
        return await action_gateway.reset_stop(request)

    @application.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        issue_codes = sorted({str(error.get("type", "invalid")) for error in exc.errors()})
        detail = "Request validation failed" + (f" ({', '.join(issue_codes)})." if issue_codes else ".")
        return _error(422, "request.invalid", detail, _request_id(request))

    @application.exception_handler(Exception)
    async def unhandled_error(request: Request, exc: Exception) -> JSONResponse:
        logger.error(
            "Unhandled request failure request_id=%s exception_type=%s",
            _request_id(request),
            type(exc).__name__,
        )
        return _error(
            500,
            "request.failed",
            "The request failed safely. Use the request ID for local diagnosis.",
            _request_id(request),
        )

    return application


def _request_id(request: Request) -> str:
    return getattr(request.state, "request_id", "unavailable")


def _error(status: int, code: str, detail: str, request_id: str) -> JSONResponse:
    body = ErrorResponse(code=code, detail=detail, request_id=request_id)
    return JSONResponse(status_code=status, content=body.model_dump(mode="json"))


app = create_app()
