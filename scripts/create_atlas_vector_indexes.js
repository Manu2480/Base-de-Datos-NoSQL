/*
 * Ejecutar en mongosh conectado a la base vector_db:
 *
 *   mongosh "mongodb+srv://<usuario>:<password>@<cluster>/?retryWrites=true&w=majority" scripts/create_atlas_vector_indexes.js
 *
 * Este script crea los índices administrados por Atlas. No reemplaza los
 * índices convencionales creados por backend/init_db.py.
 */

const chunksIndex = {
  name: "chunks_vector_index",
  type: "vectorSearch",
  definition: {
    fields: [
      {
        type: "vector",
        path: "embedding",
        numDimensions: 1024,
        similarity: "cosine"
      },
      { type: "filter", path: "estrategia_chunking" },
      { type: "filter", path: "idioma" },
      { type: "filter", path: "fecha" }
    ]
  }
};

const imagesIndex = {
  name: "imagenes_vector_index",
  type: "vectorSearch",
  definition: {
    fields: [
      {
        type: "vector",
        path: "embedding_visual",
        numDimensions: 1024,
        similarity: "cosine"
      },
      { type: "filter", path: "diagnostico_id" },
      { type: "filter", path: "paciente_id" }
    ]
  }
};

function createIfMissing(collectionName, indexDefinition) {
  const existing = db.runCommand({ listSearchIndexes: collectionName });
  const names = (existing.cursor?.firstBatch || []).map((index) => index.name);
  if (names.includes(indexDefinition.name)) {
    print(`Ya existe ${collectionName}.${indexDefinition.name}; no se modifica.`);
    return;
  }

  db.runCommand({
    createSearchIndexes: collectionName,
    indexes: [indexDefinition]
  });
  print(`Creado ${collectionName}.${indexDefinition.name}.`);
}

createIfMissing("chunks", chunksIndex);
createIfMissing("imagenes", imagesIndex);
print("Índices vectoriales solicitados. Consulte Atlas hasta que el estado sea READY.");
