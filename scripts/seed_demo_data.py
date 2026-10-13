r"""Carga datos sintéticos mínimos para probar las consultas clínicas de la API.

No elimina colecciones ni documentos existentes. Ejecutar desde la raíz:

    python scripts\seed_demo_data.py

Los documentos son ficticios y solo sirven para demostración académica.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from bson import ObjectId
from dotenv import load_dotenv

from backend.init_db import initialize
from backend.mongo import close_client, get_database

load_dotenv()


def utc(year: int, month: int, day: int) -> datetime:
    return datetime(year, month, day, tzinfo=timezone.utc)


def seed() -> None:
    uri = os.getenv("MONGODB_URI")
    if not uri:
        raise SystemExit("Defina MONGODB_URI en .env antes de ejecutar este script.")

    initialize()
    database = get_database()

    symptom_ids = [ObjectId(), ObjectId(), ObjectId(), ObjectId()]
    diagnosis_ids = [ObjectId(), ObjectId()]
    medication_ids = [ObjectId(), ObjectId(), ObjectId()]
    treatment_ids = [ObjectId(), ObjectId()]
    patient_ids = [ObjectId(), ObjectId()]
    history_ids = [ObjectId(), ObjectId()]
    assigned_ids = [ObjectId(), ObjectId(), ObjectId()]
    laboratory_ids = [ObjectId(), ObjectId(), ObjectId()]
    user_ids = [ObjectId(), ObjectId()]

    collections = {
        "sintomas": [
            {"_id": symptom_ids[0], "nombre": "Picazón", "descripcion": "Sensación de irritación y necesidad de rascarse."},
            {"_id": symptom_ids[1], "nombre": "Descamación", "descripcion": "Desprendimiento visible de escamas de la epidermis."},
            {"_id": symptom_ids[2], "nombre": "Enrojecimiento", "descripcion": "Coloración rojiza localizada o extendida."},
            {"_id": symptom_ids[3], "nombre": "Placas", "descripcion": "Lesiones elevadas o engrosadas de superficie definida."},
        ],
        "diagnosticos_dermatologicos": [
            {
                "_id": diagnosis_ids[0],
                "nombre": "Psoriasis",
                "categoria": "Inflamatoria y autoinmune",
                "descripcion": "Afección inflamatoria crónica con placas eritematosas y escamas.",
                "sintomas_ids": symptom_ids[:],
                "manifestaciones_visuales": ["Placas rojizas", "Escamas blanquecinas"],
                "tratamientos_ids": [treatment_ids[0]],
            },
            {
                "_id": diagnosis_ids[1],
                "nombre": "Dermatitis atópica",
                "categoria": "Inflamatoria y autoinmune",
                "descripcion": "Afección inflamatoria asociada con picazón, resequedad y enrojecimiento.",
                "sintomas_ids": [symptom_ids[0], symptom_ids[2]],
                "manifestaciones_visuales": ["Piel seca", "Eritema"],
                "tratamientos_ids": [treatment_ids[1]],
            },
        ],
        "medicamentos": [
            {
                "_id": medication_ids[0],
                "nombre": "Clobetasol propionato",
                "principio_activo": "Clobetasol",
                "indicaciones": ["Dermatosis inflamatorias bajo supervisión profesional."],
                "contraindicaciones": ["Infecciones cutáneas no tratadas", "Uso prolongado sin control médico"],
                "interacciones": [],
            },
            {
                "_id": medication_ids[1],
                "nombre": "Hidrocortisona tópica",
                "principio_activo": "Hidrocortisona",
                "indicaciones": ["Inflamación leve y dermatitis bajo orientación profesional."],
                "contraindicaciones": ["Alergia conocida al principio activo"],
                "interacciones": [],
            },
            {
                "_id": medication_ids[2],
                "nombre": "Amoxicilina",
                "principio_activo": "Amoxicilina",
                "indicaciones": ["Ejemplo académico de antibiótico."],
                "contraindicaciones": ["Alergia a penicilinas"],
                "interacciones": [],
            },
        ],
        "tratamientos": [
            {
                "_id": treatment_ids[0],
                "nombre": "Tratamiento tópico de psoriasis",
                "descripcion": "Ejemplo académico de tratamiento tópico.",
                "diagnosticos_ids": [diagnosis_ids[0]],
                "indicaciones": ["Aplicar únicamente según valoración profesional."],
                "precauciones": ["No automedicarse ni prolongar el uso sin control."],
                "medicamentos": [{"medicamento_id": medication_ids[0], "pautas_generales": [{"grupo_poblacional": "Adulto", "cantidad": "Capa fina", "frecuencia": "Según indicación profesional"}]}],
            },
            {
                "_id": treatment_ids[1],
                "nombre": "Tratamiento de dermatitis atópica",
                "descripcion": "Ejemplo académico de cuidado tópico e hidratación.",
                "diagnosticos_ids": [diagnosis_ids[1]],
                "indicaciones": ["Mantener hidratación y seguir valoración profesional."],
                "precauciones": ["Adaptar cualquier tratamiento a la edad y al caso clínico."],
                "medicamentos": [{"medicamento_id": medication_ids[1], "pautas_generales": [{"grupo_poblacional": "Pediátrico", "cantidad": "Según valoración", "frecuencia": "Según indicación profesional"}]}],
            },
        ],
        "pacientes": [
            {
                "_id": patient_ids[0], "codigo_paciente": "DEMO-001", "nombre_completo": "Paciente Ficticio A",
                "fecha_nacimiento": utc(1990, 5, 20), "lugar_residencia": {"pais": "Colombia", "ciudad": "Manizales"},
                "fecha_defuncion": None, "alergias": [{"sustancia": "Penicilina", "reaccion": "Erupción cutánea ficticia"}],
                "diagnosticos_asignados_ids": assigned_ids[:2], "historias_clinicas_ids": [history_ids[0]],
            },
            {
                "_id": patient_ids[1], "codigo_paciente": "DEMO-002", "nombre_completo": "Paciente Ficticio B",
                "fecha_nacimiento": utc(1985, 9, 12), "lugar_residencia": {"pais": "Colombia", "ciudad": "Manizales"},
                "fecha_defuncion": None, "alergias": [], "diagnosticos_asignados_ids": [assigned_ids[2]],
                "historias_clinicas_ids": [history_ids[1]],
            },
        ],
        "historias_medicas": [
            {"_id": history_ids[0], "paciente_id": patient_ids[0], "episodios": [{"fecha": utc(2026, 3, 15), "diagnosticos_asignados_ids": assigned_ids[:2], "observaciones": "Registro sintético de demostración.", "imagenes_ids": [], "resultados_laboratorio_ids": laboratory_ids[:2]}]},
            {"_id": history_ids[1], "paciente_id": patient_ids[1], "episodios": [{"fecha": utc(2026, 4, 2), "diagnosticos_asignados_ids": [assigned_ids[2]], "observaciones": "Registro sintético de demostración.", "imagenes_ids": [], "resultados_laboratorio_ids": [laboratory_ids[2]]}]},
        ],
        "diagnosticos_asignados": [
            {"_id": assigned_ids[0], "paciente_id": patient_ids[0], "historia_medica_id": history_ids[0], "episodio_fecha": utc(2026, 3, 15), "diagnostico_id": diagnosis_ids[0], "fecha_diagnostico": utc(2026, 3, 15), "vigente": True, "observaciones": "Registro ficticio.", "tratamientos_asignados": [{"tratamiento_id": treatment_ids[0], "fecha_inicio": utc(2026, 3, 15), "fecha_fin": None, "vigente": True, "medicamentos": [{"medicamento_id": medication_ids[0], "cantidad": "Capa fina", "frecuencia": "Según indicación"}]}]},
            {"_id": assigned_ids[1], "paciente_id": patient_ids[0], "historia_medica_id": history_ids[0], "episodio_fecha": utc(2026, 4, 15), "diagnostico_id": diagnosis_ids[1], "fecha_diagnostico": utc(2026, 4, 15), "vigente": True, "observaciones": "Registro ficticio.", "tratamientos_asignados": [{"tratamiento_id": treatment_ids[1], "fecha_inicio": utc(2026, 4, 15), "fecha_fin": None, "vigente": True, "medicamentos": [{"medicamento_id": medication_ids[1], "cantidad": "Según valoración", "frecuencia": "Según indicación"}]}]},
            {"_id": assigned_ids[2], "paciente_id": patient_ids[1], "historia_medica_id": history_ids[1], "episodio_fecha": utc(2026, 4, 2), "diagnostico_id": diagnosis_ids[1], "fecha_diagnostico": utc(2026, 4, 2), "vigente": True, "observaciones": "Registro ficticio.", "tratamientos_asignados": []},
        ],
        "resultados_laboratorio": [
            {"_id": laboratory_ids[0], "paciente_id": patient_ids[0], "historia_medica_id": history_ids[0], "fecha": utc(2026, 3, 15), "tipo_examen": "Hemograma", "formato": "JSON", "resultado": {"hemoglobina": {"valor": 14.2, "unidad": "g/dL"}, "observaciones": "Dato sintético."}},
            {"_id": laboratory_ids[1], "paciente_id": patient_ids[0], "historia_medica_id": history_ids[0], "fecha": utc(2026, 4, 15), "tipo_examen": "Proteína C reactiva", "formato": "JSON", "resultado": {"valor": 2.1, "unidad": "mg/L", "observaciones": "Dato sintético."}},
            {"_id": laboratory_ids[2], "paciente_id": patient_ids[1], "historia_medica_id": history_ids[1], "fecha": utc(2026, 4, 2), "tipo_examen": "Perfil básico", "formato": "JSON", "resultado": {"observaciones": "Dato sintético de demostración."}},
        ],
        "usuarios": [
            {"_id": user_ids[0], "nombre": "Usuario Demo A", "correo": "demo.a@example.invalid", "historial_consultas": []},
            {"_id": user_ids[1], "nombre": "Usuario Demo B", "correo": "demo.b@example.invalid", "historial_consultas": []},
        ],
    }

    inserted = {}
    for name, documents in collections.items():
        result = database[name].insert_many(documents, ordered=True)
        inserted[name] = len(result.inserted_ids)

    print("Datos sintéticos insertados:", inserted)
    print("Paciente para probar: ", patient_ids[0])
    print("Diagnóstico para probar:", diagnosis_ids[0])
    print("Usuario para probar:   ", user_ids[0])
    close_client()


if __name__ == "__main__":
    seed()
