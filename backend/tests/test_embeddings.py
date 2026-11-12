import unittest

from backend.ai import EMBEDDING_DIMENSIONS, local_text_embedding


def _cosine(left, right):
    return sum(a * b for a, b in zip(left, right))


class LocalEmbeddingTests(unittest.TestCase):
    def test_related_text_is_closer_than_unrelated_text(self):
        verruga = local_text_embedding("verruga vulgar en la piel")
        cercana = local_text_embedding("verruga vulgar")
        lejana = local_text_embedding("melanoma")
        self.assertEqual(len(verruga), EMBEDDING_DIMENSIONS)
        self.assertGreater(_cosine(verruga, cercana), _cosine(verruga, lejana))


if __name__ == "__main__":
    unittest.main()
