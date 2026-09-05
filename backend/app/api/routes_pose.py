"""Reserved standalone pose endpoint; shot analysis owns video estimation."""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()

_NOT_IMPLEMENTED = JSONResponse(
    status_code=501,
    content={
        "error": {
            "code": "not_implemented",
            "message": "Use POST /api/v1/analysis for video pose estimation.",
            "details": {},
        }
    },
)


@router.post("/pose/estimate")
def estimate_pose() -> JSONResponse:
    """Keep raw pose estimation private until it has a stable public contract."""
    return _NOT_IMPLEMENTED
