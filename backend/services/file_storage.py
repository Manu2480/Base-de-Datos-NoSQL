"""Validated local staging for files that will be ingested in Entrega 2."""

from __future__ import annotations

import json
import re
from pathlib import Path

from fastapi import HTTPException, UploadFile

PROJECT_ROOT = Path(__file__).resolve().parents[2]
INCOMING_ROOT = PROJECT_ROOT / "data" / "incoming"
STORAGE_RULES = {
    "texts": (INCOMING_ROOT / "texts", {".txt", ".md"}, 10 * 1024 * 1024),
    "images": (INCOMING_ROOT / "images", {".jpg", ".jpeg", ".png", ".webp"}, 20 * 1024 * 1024),
    "laboratory": (INCOMING_ROOT / "laboratory", {".json"}, 5 * 1024 * 1024),
}


def _safe_filename(filename: str | None) -> str:
    name = Path(filename or "").name
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name)
    if not name or name in {".", ".."}:
        raise HTTPException(status_code=422, detail="El archivo debe tener un nombre válido.")
    return name


async def stage_upload(upload: UploadFile, category: str) -> dict[str, str | int]:
    try:
        directory, allowed_extensions, max_bytes = STORAGE_RULES[category]
    except KeyError as exc:
        raise HTTPException(status_code=500, detail="Categoría de almacenamiento no configurada.") from exc

    filename = _safe_filename(upload.filename)
    extension = Path(filename).suffix.lower()
    if extension not in allowed_extensions:
        allowed = ", ".join(sorted(allowed_extensions))
        raise HTTPException(status_code=415, detail=f"Extensión no permitida. Use: {allowed}.")

    content = await upload.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise HTTPException(status_code=413, detail=f"El archivo supera el límite de {max_bytes // (1024 * 1024)} MB.")
    if category == "laboratory":
        try:
            json.loads(content.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=422, detail="El archivo de laboratorio debe ser JSON UTF-8 válido.") from exc

    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / filename
    destination.write_bytes(content)
    return {
        "categoria": category,
        "nombre_archivo": filename,
        "ruta": destination.relative_to(PROJECT_ROOT).as_posix(),
        "bytes": len(content),
    }
