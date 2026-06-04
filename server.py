"""
Defect Augmentation Tool — FastAPI server.

Usage:
    python server.py
    python server.py --data-dir "E:/path/to/images" --port 50053

The data directory should contain .png images + .json LabelMe annotations.
"""

import argparse
import base64
import json
import math
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ─── Config ────────────────────────────────────────────────────────────────

IMAGE_DIR: Path = None   # set by parse_args
OUTPUT_DIR: Path = None
STATIC_DIR = Path(__file__).parent / "static"


def parse_args():
    parser = argparse.ArgumentParser(description="Defect Augmentation Tool")
    parser.add_argument("--data-dir", default=os.environ.get("AUGMENT_DATA_DIR", ""),
                        help="Path to image+JSON directory")
    parser.add_argument("--output-dir", default=os.environ.get("AUGMENT_OUTPUT_DIR", ""),
                        help="Output directory for saved composites")
    parser.add_argument("--port", type=int, default=int(os.environ.get("AUGMENT_PORT", "50053")),
                        help="Server port (default: 50053)")
    return parser.parse_args()


# ─── Data Layer ────────────────────────────────────────────────────────────

def parse_labelme_json(json_path: Path) -> Dict[str, Any]:
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    shapes = []
    for shape in data.get("shapes", []):
        points = shape.get("points", [])
        shapes.append({
            "label": shape.get("label", "unknown"),
            "points": [[float(p[0]), float(p[1])] for p in points],
            "shape_type": shape.get("shape_type", "polygon"),
        })
    return {
        "shapes": shapes,
        "image_width": data.get("imageWidth", 451),
        "image_height": data.get("imageHeight", 363),
    }


def get_all_images() -> List[Dict[str, Any]]:
    results = []
    for png_path in sorted(IMAGE_DIR.glob("*.png")):
        json_path = png_path.with_suffix(".json")
        filename = png_path.name
        image_id = filename.replace(".png", "")

        shapes = []
        annotation = None
        if json_path.exists():
            annotation = parse_labelme_json(json_path)
            shapes = annotation["shapes"]
        labels = [s["label"] for s in shapes]

        results.append({
            "id": image_id,
            "filename": filename,
            "label": labels[0] if labels else "none",
            "all_labels": labels,
            "shapes": shapes,
            "shape_count": len(shapes),
            "image_width": annotation["image_width"] if annotation else 451,
            "image_height": annotation["image_height"] if annotation else 363,
        })
    return results


# ─── Compositor ────────────────────────────────────────────────────────────

def extract_defect_region(image: np.ndarray, polygon_pts: List[List[float]]) -> Dict[str, Any]:
    h, w = image.shape[:2]
    pts_int = np.array([[int(p[0]), int(p[1])] for p in polygon_pts], dtype=np.int32)
    mask = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(mask, [pts_int], 255)
    x, y, bw, bh = cv2.boundingRect(pts_int)
    pad = 3
    x = max(0, x - pad); bw = min(w - x, bw + 2 * pad)
    y = max(0, y - pad); bh = min(h - y, bh + 2 * pad)
    roi_bgr = image[y:y + bh, x:x + bw]
    roi_mask = mask[y:y + bh, x:x + bw]
    roi_bgra = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2BGRA)
    roi_bgra[:, :, 3] = roi_mask
    return {"cropped_bgra": roi_bgra, "bbox": (x, y, bw, bh), "mask": mask, "polygon_pts_int": pts_int}


def build_transform_matrix(src_w: int, src_h: int, scale: float = 1.0,
                           rotation_deg: float = 0.0, shear_x: float = 0.0,
                           shear_y: float = 0.0, offset_x: float = 0,
                           offset_y: float = 0) -> np.ndarray:
    cx, cy = src_w / 2.0, src_h / 2.0
    theta = math.radians(rotation_deg)
    T1 = np.array([[1, 0, -cx], [0, 1, -cy], [0, 0, 1]], dtype=np.float64)
    S  = np.array([[scale, 0, 0], [0, scale, 0], [0, 0, 1]], dtype=np.float64)
    Hx = np.array([[1, shear_x, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float64)
    Hy = np.array([[1, 0, 0], [shear_y, 1, 0], [0, 0, 1]], dtype=np.float64)
    R  = np.array([[math.cos(theta), -math.sin(theta), 0],
                   [math.sin(theta),  math.cos(theta), 0],
                   [0, 0, 1]], dtype=np.float64)
    T2 = np.array([[1, 0, offset_x], [0, 1, offset_y], [0, 0, 1]], dtype=np.float64)
    M_3x3 = T2 @ R @ Hy @ Hx @ S @ T1
    return M_3x3[:2, :].astype(np.float64)


def adjust_color(defect_bgra: np.ndarray, brightness: float = 0.0, contrast: float = 1.0,
                 hue_shift: float = 0.0, saturation_scale: float = 1.0) -> np.ndarray:
    bgr, alpha = defect_bgra[:, :, :3], defect_bgra[:, :, 3].copy()
    if brightness != 0 or contrast != 1.0:
        bgr = cv2.convertScaleAbs(bgr, alpha=float(contrast), beta=float(brightness))
    if hue_shift != 0 or saturation_scale != 1.0:
        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
        hsv[:, :, 0] = np.mod(hsv[:, :, 0] + hue_shift, 180.0)
        hsv[:, :, 1] = np.clip(hsv[:, :, 1] * saturation_scale, 0, 255)
        bgr = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    result = cv2.cvtColor(bgr, cv2.COLOR_BGR2BGRA)
    result[:, :, 3] = alpha
    return result


def blend_onto_target(target_bgr: np.ndarray, warped_defect_bgra: np.ndarray) -> np.ndarray:
    alpha = warped_defect_bgra[:, :, 3:4].astype(np.float32) / 255.0
    blended = (warped_defect_bgra[:, :, :3].astype(np.float32) * alpha +
               target_bgr.astype(np.float32) * (1.0 - alpha))
    return blended.astype(np.uint8)


def image_to_base64(image: np.ndarray, fmt: str = ".png") -> str:
    success, buf = cv2.imencode(fmt, image)
    return base64.b64encode(buf.tobytes()).decode("ascii") if success else ""


def composite(source_bgr, polygon_pts, target_bgr, position_x, position_y,
              scale=1.0, rotation_deg=0.0, shear_x=0.0, shear_y=0.0,
              brightness=0.0, contrast=1.0, hue_shift=0.0, saturation_scale=1.0) -> np.ndarray:
    extracted = extract_defect_region(source_bgr, polygon_pts)
    defect_bgra = extracted["cropped_bgra"]
    bw, bh = defect_bgra.shape[1], defect_bgra.shape[0]
    defect_bgra = adjust_color(defect_bgra, brightness, contrast, hue_shift, saturation_scale)
    M = build_transform_matrix(bw, bh, scale, rotation_deg, shear_x, shear_y, position_x, position_y)
    output_size = (target_bgr.shape[1], target_bgr.shape[0])
    warped = cv2.warpAffine(defect_bgra, M, output_size,
                            flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    return blend_onto_target(target_bgr, warped)


def composite_all(background_bgr, source_images, paste_ops):
    result = background_bgr.copy()
    for op in paste_ops:
        src_id = op["source_image_id"]
        if src_id not in source_images:
            continue
        result = composite(source_bgr=source_images[src_id], polygon_pts=op["polygon_points"],
                           target_bgr=result, position_x=op.get("position_x", 225),
                           position_y=op.get("position_y", 181), scale=op.get("scale", 1.0),
                           rotation_deg=op.get("rotation", 0.0), shear_x=op.get("shear_x", 0.0),
                           shear_y=op.get("shear_y", 0.0), brightness=op.get("brightness", 0.0),
                           contrast=op.get("contrast", 1.0), hue_shift=op.get("hue_shift", 0.0),
                           saturation_scale=op.get("saturation_scale", 1.0))
    return result


# ─── FastAPI App ───────────────────────────────────────────────────────────

app = FastAPI(title="Defect Augmentation Tool")


@app.get("/api/health")
def health():
    return {"status": "ok", "data_dir": str(IMAGE_DIR), "images": len(get_all_images())}


@app.get("/api/images")
def list_images():
    images = get_all_images()
    return {"images": images, "total": len(images)}


@app.get("/api/image/{image_id}")
def serve_image(image_id: str):
    png_path = IMAGE_DIR / f"{image_id}.png"
    if not png_path.exists():
        return JSONResponse(status_code=404, content={"error": "Image not found"})
    return Response(content=png_path.read_bytes(), media_type="image/png")


@app.get("/api/image/{image_id}/info")
def serve_image_info(image_id: str):
    json_path = IMAGE_DIR / f"{image_id}.json"
    if not json_path.exists():
        return JSONResponse(status_code=404, content={"error": "Annotation not found"})
    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    shapes = [{"label": s.get("label", "unknown"),
               "points": [[float(p[0]), float(p[1])] for p in s.get("points", [])]}
              for s in data.get("shapes", [])]
    return {"id": image_id, "shapes": shapes}


class CropRequest(BaseModel):
    source_image_id: str
    polygon_points: List[List[float]]


@app.post("/api/crop-defect")
def crop_defect(req: CropRequest):
    src_path = IMAGE_DIR / f"{req.source_image_id}.png"
    if not src_path.exists():
        return JSONResponse(status_code=404, content={"error": "Source not found"})
    src_bgr = cv2.imread(str(src_path))
    if src_bgr is None:
        return JSONResponse(status_code=500, content={"error": "Failed to load image"})
    try:
        extracted = extract_defect_region(src_bgr, req.polygon_points)
        bgra = extracted["cropped_bgra"]
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Crop failed: {e}"})
    rgba = cv2.cvtColor(bgra, cv2.COLOR_BGRA2RGBA)
    success, buf = cv2.imencode(".png", rgba)
    if not success:
        return JSONResponse(status_code=500, content={"error": "PNG encode failed"})
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return {"status": "success", "crop_base64": b64, "width": bgra.shape[1], "height": bgra.shape[0]}


class PasteOp(BaseModel):
    source_image_id: str
    polygon_points: List[List[float]]
    position_x: float = 225
    position_y: float = 181
    scale: float = 1.0
    rotation: float = 0.0
    shear_x: float = 0.0
    shear_y: float = 0.0
    brightness: float = 0.0
    contrast: float = 1.0
    hue_shift: float = 0.0
    saturation_scale: float = 1.0


class CompositeRequest(BaseModel):
    background_image_id: str
    paste_ops: List[PasteOp] = []
    output_name: Optional[str] = None


@app.post("/api/composite")
def do_composite(req: CompositeRequest):
    bg_path = IMAGE_DIR / f"{req.background_image_id}.png"
    if not bg_path.exists():
        return JSONResponse(status_code=404, content={"error": "Background not found"})
    bg_bgr = cv2.imread(str(bg_path))
    if bg_bgr is None:
        return JSONResponse(status_code=500, content={"error": "Failed to load background"})

    source_images = {}
    for op in req.paste_ops:
        if op.source_image_id not in source_images:
            src_path = IMAGE_DIR / f"{op.source_image_id}.png"
            if src_path.exists():
                src_bgr = cv2.imread(str(src_path))
                if src_bgr is not None:
                    source_images[op.source_image_id] = src_bgr

    result_bgr = composite_all(bg_bgr, source_images, [op.model_dump() for op in req.paste_ops])
    return {"status": "success", "composite_base64": image_to_base64(result_bgr)}


@app.post("/api/save")
def save_result(req: CompositeRequest):
    bg_path = IMAGE_DIR / f"{req.background_image_id}.png"
    bg_bgr = cv2.imread(str(bg_path))
    if bg_bgr is None:
        return JSONResponse(status_code=500, content={"error": "Failed to load background"})

    source_images = {}
    for op in req.paste_ops:
        if op.source_image_id not in source_images:
            src_path = IMAGE_DIR / f"{op.source_image_id}.png"
            if src_path.exists():
                src_bgr = cv2.imread(str(src_path))
                if src_bgr is not None:
                    source_images[op.source_image_id] = src_bgr

    result_bgr = composite_all(bg_bgr, source_images, [op.model_dump() for op in req.paste_ops])

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if req.output_name:
        out_name = req.output_name if req.output_name.endswith('.png') else f"{req.output_name}.png"
    else:
        out_name = f"aug_{req.background_image_id}.png"

    base, ext = out_name.rsplit('.', 1) if '.' in out_name else (out_name, 'png')
    out_path = OUTPUT_DIR / out_name
    counter = 2
    while out_path.exists():
        out_path = OUTPUT_DIR / f"{base}_{counter}.{ext}"
        counter += 1

    cv2.imwrite(str(out_path), result_bgr)
    return {"status": "success", "saved_path": str(out_path),
            "composite_base64": image_to_base64(result_bgr), "consumed_source_ids": []}


# Mount static files last
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


# ─── Main ──────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    args = parse_args()

    if not args.data_dir:
        print("ERROR: --data-dir is required. Example:")
        print("  python server.py --data-dir E:/Download/cv_result/cv_result/raw/inpocket-gen")
        sys.exit(1)

    IMAGE_DIR = Path(args.data_dir)
    if not IMAGE_DIR.is_dir():
        print(f"ERROR: data-dir not found: {IMAGE_DIR}")
        sys.exit(1)

    OUTPUT_DIR = Path(args.output_dir) if args.output_dir else Path(__file__).parent / "output"
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Data dir:    {IMAGE_DIR}")
    print(f"Output dir:  {OUTPUT_DIR}")
    print(f"Images:      {len(get_all_images())}")
    print(f"Server:      http://0.0.0.0:{args.port}")

    uvicorn.run(app, host="0.0.0.0", port=args.port)
