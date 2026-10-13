"""Text chunking strategies used by the knowledge-ingestion pipeline."""

from __future__ import annotations

import re
from collections.abc import Sequence
from math import sqrt


STRATEGIES = ("fixed-size", "sentence-aware", "semantic")
_SENTENCE_PATTERN = re.compile(r"(?<=[.!?])\s+")


def split_sentences(text: str) -> list[str]:
    return [part.strip() for part in _SENTENCE_PATTERN.split(text.strip()) if part.strip()]


def fixed_size_chunks(text: str, size: int = 256, overlap: int = 32) -> list[str]:
    if size < 1 or overlap < 0 or overlap >= size:
        raise ValueError("size debe ser positivo y overlap debe estar entre 0 y size - 1.")
    words = text.split()
    step = size - overlap
    chunks = []
    for start in range(0, len(words), step):
        chunks.append(" ".join(words[start : start + size]))
        if start + size >= len(words):
            break
    return chunks


def sentence_aware_chunks(
    text: str, max_sentences: int = 5, overlap_sentences: int = 1
) -> list[str]:
    if max_sentences < 1 or not 0 <= overlap_sentences < max_sentences:
        raise ValueError("La cantidad de oraciones y su solapamiento no son válidos.")
    sentences = split_sentences(text)
    step = max_sentences - overlap_sentences
    chunks = []
    for start in range(0, len(sentences), step):
        chunks.append(" ".join(sentences[start : start + max_sentences]))
        if start + max_sentences >= len(sentences):
            break
    return chunks


def _cosine_similarity(left: Sequence[float], right: Sequence[float]) -> float:
    if len(left) != len(right) or not left:
        raise ValueError("Los embeddings semánticos deben tener igual dimensión.")
    left_norm = sqrt(sum(value * value for value in left))
    right_norm = sqrt(sum(value * value for value in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return sum(a * b for a, b in zip(left, right)) / (left_norm * right_norm)


def semantic_chunks(
    sentences: Sequence[str],
    sentence_embeddings: Sequence[Sequence[float]],
    threshold: float = 0.8,
    max_words: int = 256,
) -> list[str]:
    if len(sentences) != len(sentence_embeddings):
        raise ValueError("Se requiere un embedding por cada oración.")
    if not 0 <= threshold <= 1 or max_words < 1:
        raise ValueError("El umbral debe estar entre 0 y 1 y max_words debe ser positivo.")
    if not sentences:
        return []

    groups: list[list[str]] = []
    current: list[str] = []
    word_count = 0
    for index, sentence in enumerate(sentences):
        sentence_words = sentence.split()
        similarity = (
            _cosine_similarity(sentence_embeddings[index - 1], sentence_embeddings[index])
            if index > 0
            else 1.0
        )
        if current and (similarity < threshold or word_count + len(sentence_words) > max_words):
            groups.append(current)
            current = []
            word_count = 0
        current.append(sentence)
        word_count += len(sentence_words)
    if current:
        groups.append(current)
    return [" ".join(group) for group in groups]


def chunk_text(
    text: str,
    strategy: str,
    sentence_embeddings: Sequence[Sequence[float]] | None = None,
    threshold: float = 0.8,
) -> list[str]:
    if strategy == "fixed-size":
        return fixed_size_chunks(text)
    if strategy == "sentence-aware":
        return sentence_aware_chunks(text)
    if strategy == "semantic":
        sentences = split_sentences(text)
        if sentence_embeddings is None:
            raise ValueError("La estrategia semantic requiere embeddings de oraciones.")
        return semantic_chunks(sentences, sentence_embeddings, threshold=threshold)
    raise ValueError(f"Estrategia de chunking no soportada: {strategy}")
