"""Camera-position check and spatial alignment for the compare domain.

V1 assumes both clips come from the same camera position, so background
pixels should largely coincide. We detect background features (ORB) with the
person masked out, estimate a homography with RANSAC, and grade the match by
inlier ratio. The homography is also converted to a best-fit affine (Canvas
2D cannot apply projective transforms) for the overlay view.
"""

from dataclasses import dataclass

import numpy as np

from app.core.config import Settings
from app.schemas.compare import AffineTransform, CameraCheckResult

MIN_MATCHES = 20
MAX_SAMPLE_FRAMES = 5


@dataclass
class PairStats:
    inliers: int
    matches: int
    homography: np.ndarray | None


def person_mask(shape: tuple[int, int], keypoints, margin: float = 0.25) -> np.ndarray:
    """Boolean mask (h, w) that is True on background, False on the person."""
    h, w = shape
    mask = np.full((h, w), True)
    pts = [(float(kp.x) * w, float(kp.y) * h) for kp in keypoints if kp.confidence >= 0.5]
    if not pts:
        return mask
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    bw, bh = max(x1 - x0, 1.0), max(y1 - y0, 1.0)
    x0, x1 = max(0, int(x0 - bw * margin)), min(w, int(x1 + bw * margin))
    y0, y1 = max(0, int(y0 - bh * margin)), min(h, int(y1 + bh * margin))
    mask[y0:y1, x0:x1] = False
    return mask


def _match_pair(frame_a: np.ndarray, frame_b: np.ndarray, mask_a: np.ndarray, mask_b: np.ndarray) -> PairStats:
    import cv2

    orb = cv2.ORB_create(nfeatures=800)
    gray_a = cv2.cvtColor(frame_a, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(frame_b, cv2.COLOR_BGR2GRAY)
    kp_a, des_a = orb.detectAndCompute(gray_a, mask_a.astype(np.uint8))
    kp_b, des_b = orb.detectAndCompute(gray_b, mask_b.astype(np.uint8))
    if des_a is None or des_b is None or not len(kp_a) or not len(kp_b):
        return PairStats(0, 0, None)
    bf = cv2.BFMatcher(cv2.NORM_HAMMING)
    knn = bf.knnMatch(des_a, des_b, k=2)
    good = [m for m, n in knn if m.distance < 0.75 * n.distance]
    if len(good) < MIN_MATCHES:
        return PairStats(0, len(good), None)
    src = np.float32([kp_a[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float32([kp_b[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    h_mat, inlier_mask = cv2.findHomography(src, dst, cv2.RANSAC, 3.0)
    if h_mat is None:
        return PairStats(0, len(good), None)
    inliers = int(inlier_mask.sum())
    return PairStats(inliers, len(good), h_mat)


def check_camera(pairs: list[PairStats], cfg: Settings) -> CameraCheckResult:
    matches = sum(p.matches for p in pairs)
    inliers = sum(p.inliers for p in pairs)
    if matches < MIN_MATCHES:
        return CameraCheckResult(status="mismatch", inlier_ratio=0.0, matches=matches, homography=None)
    ratio = inliers / matches
    if ratio >= cfg.compare_camera_match_ratio:
        status = "match"
    elif ratio >= cfg.compare_camera_suspect_ratio:
        status = "suspect"
    else:
        status = "mismatch"
    best = max(pairs, key=lambda p: p.inliers)
    homography = (
        [[float(v) for v in row] for row in best.homography]
        if best.homography is not None
        else None
    )
    return CameraCheckResult(status=status, inlier_ratio=round(ratio, 3), matches=matches, homography=homography)


def homography_to_affine(h_mat: np.ndarray) -> AffineTransform:
    """Best-fit affine (scale + rotation + translation) to a homography."""
    src = np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]])
    import cv2

    dst = cv2.perspectiveTransform(src.reshape(1, -1, 2), h_mat).reshape(-1, 2)
    design = np.concatenate([src, np.ones((4, 1))], axis=1)
    sol, *_ = np.linalg.lstsq(design, dst, rcond=None)
    linear = sol[:2].T
    t = sol[2]
    u, s, vt = np.linalg.svd(linear)
    rot = u @ vt
    if np.linalg.det(rot) < 0:
        u[:, -1] *= -1
        rot = u @ vt
    scale = float(np.mean(s)) if len(s) else 1.0
    rotation = float(np.degrees(np.arctan2(rot[1, 0], rot[0, 0])))
    return AffineTransform(tx=float(t[0]), ty=float(t[1]), scale=scale, rotation_deg=rotation)


def fit_affine(pairs: list[PairStats]) -> AffineTransform | None:
    if not pairs:
        return None
    best = max(pairs, key=lambda p: p.inliers)
    if best.homography is None:
        return None
    return homography_to_affine(best.homography)


def sample_frame_indices(frame_count: int) -> list[int]:
    """Evenly spaced frame indices, at most MAX_SAMPLE_FRAMES."""
    if frame_count <= MAX_SAMPLE_FRAMES:
        return list(range(frame_count))
    step = (frame_count - 1) / (MAX_SAMPLE_FRAMES - 1)
    return sorted({round(i * step) for i in range(MAX_SAMPLE_FRAMES)})
