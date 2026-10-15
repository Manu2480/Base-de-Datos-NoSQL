# ENTREGA II
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from fastapi.testclient import TestClient
from fastapi import HTTPException
from pymongo.errors import OperationFailure

from backend.main import SearchInput, _search_filter, _text_search, _vector_search, app


class ApiContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def test_frontend_and_openapi_are_served(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertEqual(self.client.get("/openapi.json").status_code, 200)

    def test_health_reports_missing_mongodb_configuration(self):
        with patch.dict(os.environ, {"MONGODB_URI": ""}):
            response = self.client.get("/api/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "degraded")
        self.assertEqual(response.json()["mongodb"], "disconnected")

    def test_collection_allowlist_rejects_unknown_names(self):
        response = self.client.get("/api/collections/not_a_collection")
        self.assertEqual(response.status_code, 404)

    def test_invalid_search_payload_is_rejected_before_database_access(self):
        response = self.client.post("/api/search", json={"query": "   "})
        self.assertEqual(response.status_code, 422)

    def test_required_project_routes_are_documented(self):
        paths = self.client.get("/openapi.json").json()["paths"]
        for path in (
            "/api/search",
            "/api/rag",
            "/api/ingest",
            "/api/images",
            "/api/images/search",
            "/api/uploads/texts",
            "/api/uploads/images",
            "/api/uploads/laboratory",
            "/api/users/{user_id}/queries",
            "/api/patients/{patient_id}/history",
        ):
            self.assertIn(path, paths)

    def test_staging_rejects_unsupported_file_extensions(self):
        response = self.client.post(
            "/api/uploads/laboratory",
            files={"file": ("exam.txt", b"not json", "text/plain")},
        )
        self.assertEqual(response.status_code, 415)

    def test_image_upload_rejects_a_mismatched_file_signature(self):
        response = self.client.post(
            "/api/images",
            files={"image": ("lesion.jpg", b"not a JPEG", "image/jpeg")},
        )
        self.assertEqual(response.status_code, 422)

    def test_vector_search_builds_expected_atlas_filters_and_source_lookup(self):
        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        end = datetime(2026, 12, 31, tzinfo=timezone.utc)
        request = SearchInput(
            query="consulta",
            estrategia_chunking="sentence-aware",
            idioma="es",
            fecha_desde=start,
            fecha_hasta=end,
            top_k=4,
        )
        captured = {}

        class FakeCollection:
            def aggregate(self, pipeline):
                captured["pipeline"] = pipeline
                return []

        with patch("backend.main._collection", return_value=FakeCollection()):
            self.assertEqual(_vector_search([0.1] * 1024, request), [])

        stages = captured["pipeline"]
        vector = stages[0]["$vectorSearch"]
        self.assertEqual(vector["index"], "chunks_vector_index")
        self.assertEqual(vector["limit"], 4)
        self.assertEqual(
            vector["filter"],
            {
                "estrategia_chunking": {"$eq": "sentence-aware"},
                "idioma": {"$eq": "es"},
                "fecha": {"$gte": start, "$lte": end},
            },
        )
        self.assertEqual(stages[1]["$lookup"]["from"], "documentos_conocimiento")

    def test_text_search_uses_regex_fallback_only_when_text_index_is_missing(self):
        calls = []

        class FakeCursor:
            def sort(self, *_args):
                return self

            def limit(self, *_args):
                return []

        class MissingIndexCollection:
            def find(self, query, *_args):
                calls.append(query)
                if len(calls) == 1:
                    raise OperationFailure("text index required", code=27)
                return FakeCursor()

        with patch("backend.main._collection", return_value=MissingIndexCollection()):
            self.assertEqual(_text_search(SearchInput(query="placa (rojiza)")), [])
        self.assertIn("$text", calls[0])
        self.assertEqual(calls[1]["chunk_texto"]["$regex"], r"placa\ \(rojiza\)")

        class UnavailableCollection:
            def find(self, *_args):
                raise OperationFailure("not authorized", code=13)

        with patch("backend.main._collection", return_value=UnavailableCollection()):
            with patch("backend.main.logger.exception"):
                with self.assertRaises(HTTPException) as raised:
                    _text_search(SearchInput(query="consulta"))
        self.assertEqual(raised.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
