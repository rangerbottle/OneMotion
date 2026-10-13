"""Preserve the API's string detail contract for typed request validation."""

from typing import Callable

from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from starlette.requests import Request
from starlette.responses import Response


def validation_detail(errors: list[dict]) -> str:
    # Locations and messages are useful; raw input must not be echoed back.
    return "; ".join(
        f"{'.'.join(str(part) for part in error['loc']) or 'body'}: {error['msg']}"
        for error in errors
    )


class StringDetailRoute(APIRoute):
    def get_route_handler(self) -> Callable:
        handler = super().get_route_handler()

        async def validated_handler(request: Request) -> Response:
            try:
                return await handler(request)
            except RequestValidationError as exc:
                return JSONResponse(status_code=422, content={"detail": validation_detail(exc.errors())})

        return validated_handler
