"""Small HTTP clients for Jina embeddings and the Groq chat-completions API."""

from __future__ import annotations

import base64
import json
import math
import os
import urllib.error
import urllib.request
from typing import Any

from fastapi import HTTPException

EMBEDDING_MODEL = "jina-clip-v2"
EMBEDDING_DIMENSIONS = 1024


def _post_json(url: str, api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"El proveedor externo respondió HTTP {exc.code}."
        ) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise HTTPException(status_code=502, detail="No fue posible conectar con el proveedor externo.") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=502, detail="El proveedor externo devolvió una respuesta no válida.") from exc


def _jina_api_key() -> str:
    key = os.getenv("JINA_API_KEY")
    if not key:
        raise HTTPException(status_code=503, detail="Configure JINA_API_KEY para generar embeddings.")
    return key


def _get_vectors(payload: dict[str, Any]) -> list[list[float]]:
    response = _post_json("https://api.jina.ai/v1/embeddings", _jina_api_key(), payload)
    try:
        vectors = [item["embedding"] for item in response["data"]]
    except (KeyError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="La respuesta de embeddings no tiene el formato esperado.") from exc
    if any(
        not isinstance(vector, list)
        or len(vector) != EMBEDDING_DIMENSIONS
        or any(not isinstance(value, (int, float)) or not math.isfinite(value) for value in vector)
        for vector in vectors
    ):
        raise HTTPException(status_code=502, detail="Jina devolvió un vector inválido; se esperaban 1024 valores numéricos.")
    return vectors


def embed_texts(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    vectors: list[list[float]] = []
    for start in range(0, len(texts), 64):
        batch = texts[start : start + 64]
        batch_vectors = _get_vectors(
            {
                "model": EMBEDDING_MODEL,
                "dimensions": EMBEDDING_DIMENSIONS,
                "input": [{"text": text} for text in batch],
            }
        )
        if len(batch_vectors) != len(batch):
            raise HTTPException(status_code=502, detail="Jina devolvió una cantidad inesperada de embeddings.")
        vectors.extend(batch_vectors)
    return vectors


def embed_image(image: bytes, content_type: str) -> list[float]:
    encoded = base64.b64encode(image).decode("ascii")
    vector = _get_vectors(
        {
            "model": EMBEDDING_MODEL,
            "dimensions": EMBEDDING_DIMENSIONS,
            "input": [{"image": f"data:{content_type};base64,{encoded}"}],
        }
    )
    if len(vector) != 1:
        raise HTTPException(status_code=502, detail="Jina no devolvió el embedding de la imagen.")
    return vector[0]


def generate_answer(question: str, contexts: list[dict[str, Any]]) -> str:
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Configure GROQ_API_KEY para generar respuestas RAG.")
    context_text = "\n\n".join(
        f"[Fuente {index}: {item.get('nombre_archivo', item.get('doc_id', 'sin fuente'))}]\n"
        f"{item['chunk_texto']}"
        for index, item in enumerate(contexts, start=1)
    )
    prompt = (
        "Responde en español únicamente con la información del contexto. "
        "Si el contexto no permite responder, indícalo. Cita las fuentes como [Fuente N]. "
        "La respuesta es informativa y no sustituye la valoración de un profesional de salud.\n\n"
        f"Contexto:\n{context_text}\n\nPregunta: {question}"
    )
    response = _post_json(
        "https://api.groq.com/openai/v1/chat/completions",
        api_key,
        {
            "model": os.getenv("GROQ_MODEL", "llama-3.1-8b-instant"),
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.2,
        },
    )
    try:
        answer = response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise HTTPException(status_code=502, detail="La respuesta del modelo de lenguaje no tiene el formato esperado.") from exc
    if not isinstance(answer, str) or not answer.strip():
        raise HTTPException(status_code=502, detail="El modelo de lenguaje devolvió una respuesta vacía.")
    return answer
