import unittest

from backend.chunking import (
    fixed_size_chunks,
    semantic_chunks,
    sentence_aware_chunks,
    split_sentences,
)


class ChunkingTests(unittest.TestCase):
    def test_fixed_size_chunks_keep_overlap(self):
        chunks = fixed_size_chunks("uno dos tres cuatro cinco", size=3, overlap=1)
        self.assertEqual(chunks, ["uno dos tres", "tres cuatro cinco"])

    def test_sentence_aware_chunks_keep_one_sentence_overlap(self):
        text = "Primera. Segunda. Tercera. Cuarta."
        self.assertEqual(
            sentence_aware_chunks(text, max_sentences=2, overlap_sentences=1),
            ["Primera. Segunda.", "Segunda. Tercera.", "Tercera. Cuarta."],
        )

    def test_sentence_splitter_handles_question_and_exclamation(self):
        self.assertEqual(
            split_sentences("¿Qué es esto? Es una prueba. ¡Fin!"),
            ["¿Qué es esto?", "Es una prueba.", "¡Fin!"],
        )

    def test_semantic_chunks_start_new_group_below_threshold(self):
        chunks = semantic_chunks(
            ["tema uno", "tema relacionado", "otro tema"],
            [[1.0, 0.0], [0.99, 0.01], [0.0, 1.0]],
            threshold=0.8,
        )
        self.assertEqual(chunks, ["tema uno tema relacionado", "otro tema"])

    def test_semantic_chunking_requires_one_vector_per_sentence(self):
        with self.assertRaises(ValueError):
            semantic_chunks(["una", "dos"], [[1.0, 0.0]])

    def test_invalid_fixed_chunk_overlap_is_rejected(self):
        with self.assertRaises(ValueError):
            fixed_size_chunks("texto", size=4, overlap=4)


if __name__ == "__main__":
    unittest.main()
