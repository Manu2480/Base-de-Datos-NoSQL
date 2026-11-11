import json
import unittest
from datetime import datetime, timezone

from bson import ObjectId

from backend.load_conocimiento import CORPUS_PATH, TEMA_A_NOMBRE, prepare_document


class KnowledgeLinkTests(unittest.TestCase):
    def test_every_disease_topic_in_the_corpus_has_a_diagnosis_name(self):
        documents = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
        topics = {item["tema"] for item in documents if not item["tema"].startswith("transversal")}
        self.assertEqual(topics, set(TEMA_A_NOMBRE))

    def test_disease_text_links_to_the_clinical_diagnosis(self):
        diagnosis_id = ObjectId()
        prepared = prepare_document(
            {
                "nombre_archivo": "tinea-pedis__descripcion.txt",
                "tipo_documento": "Texto",
                "idioma": "es",
                "contenido_texto": "Texto de tiña.",
                "titulo": "Tiña",
                "tema": "tinea-pedis",
                "categoria": "descripcion",
                "fuente": "fuente",
                "fecha": {"$date": "2026-11-07T00:00:00Z"},
            },
            {"Tiña pedis": diagnosis_id},
        )
        self.assertEqual(prepared["diagnostico_id"], diagnosis_id)
        self.assertEqual(prepared["fecha"], datetime(2026, 11, 7, tzinfo=timezone.utc))

    def test_transversal_guide_stays_unlinked(self):
        prepared = prepare_document(
            {
                "nombre_archivo": "transversal-fotoproteccion__guia.txt",
                "contenido_texto": "Use protector solar.",
                "tema": "transversal-fotoproteccion",
                "categoria": "guia",
                "fecha": "2026-11-07T00:00:00+00:00",
            },
            {"Vitíligo": ObjectId()},
        )
        self.assertNotIn("diagnostico_id", prepared)
