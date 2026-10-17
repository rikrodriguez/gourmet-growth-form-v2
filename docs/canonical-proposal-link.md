# Vínculo canónico de propuesta: adaptador independiente, sólo sintético

## Fuente demostrada y dato pendiente

PR14, head `3720bcf452886e9542101b3d27bb82f56922dfea`, contiene el lector staff real del Growth Dashboard y el vínculo SQL `lead_id → monday_item_id`. Sus roles `admin/viewer` sólo autorizan lectura. `growth_v2.events.event_id` identifica telemetría; no es un evento de catering. El mapper CRM de esa línea no produce las columnas Calculator/Quotes.

En los snapshots versionados inspeccionados no se encontró el módulo que genera Calculator/Quotes y escribe `text_mm1kdqqb/text_mm1mkvn`. No se consultó hosting ni se abrieron documentos para suplir esa ausencia. Esto no afirma que dicho código no exista en el servidor. Los documentos anteriores sobre ausencia de login se refieren a la línea Office; PR14 demuestra el lector de sesión comercial en otra línea.

Para conectar el caso real falta una evidencia concreta: **repositorio/ruta o snapshot saneado de código del productor**, junto con su función que declara la correspondencia autorizada entre UUID del lead Growth, cuenta/board/item CRM, evento de catering y documento/versión. También falta el contrato de lectura de bytes de esa versión. Una URL, nombre, fecha o sesión de visitante no sustituye esa correspondencia. Sin ella no se puede decidir qué tres registros vincular ni qué versión revisar. El permiso de aprobación sigue siendo una cuestión independiente; no se amplía aquí.

## Resultado funcional independiente

`createCanonicalProposalDocumentProvider` compone el `CanonicalBridge` y `ExternalProposalDocumentProvider` existentes. Se puede entregar al `ExternalProposalService` o a `publishFromProvider` del servicio durable actual. No requiere otro editor, esquema, registro de IDs o sistema de permisos. Este PR se apoya en Office/PR13 `4898297fdb6f24b8bec1b08a0aec1feb021a4309`; no mezcla esa línea con PR14 ni activa un puente comercial entre ambas.

El puerto server-side `ExistingCanonicalProposalLinkOwner.readExistingLink(target)` debe leer una relación **ya existente y autorizada** y devolver `CanonicalProposalSelection`:

- `target`: IDs explícitos de lead, evento y propuesta. El lead y el item CRM son namespaces distintos.
- `scope` test y `bridgeScope` demo del ledger existente.
- `source`: cuenta, board e item CRM usados por la procedencia documental.
- `binding`: ID, revisión y digest exactos del vínculo seleccionado; no se elige el primero o el último disponible como alternativa.
- `references`: referencias canónicas completas `sourceSystem/boardId/itemId` de lead, evento y propuesta. Evento y propuesta deben usar sus IDs explícitos en `itemId`, como exige el servicio existente. Si el productor usa otra identidad, su dueño debe aportar la traducción autorizada; este adaptador no la adivina.

El llamador ya autorizado fija además `expected`: target, scope documental, scope canónico con actor, mapping CRM y bindingId. Se copia al crear el adaptador y no procede de la respuesta del owner. La selección debe coincidir exactamente; un ledger válido de otro actor/organización o un vínculo alternativo no satisfacen ese contexto.

El adaptador exige que esa revisión siga activa y contenga las tres versiones de tipo lead/event/quote. Compara cada referencia completa y el mapping CRM. La versión opaca del documento debe coincidir con la versión quote del ledger, y su SHA-256 calculado sobre UTF-8 exacto debe coincidir con `contentDigest`. `quote` aquí es metadata documental del ledger, no una cotización calculada: no se crean `QuoteVersion` ni líneas/precios.

Después de leer el proveedor vuelve a leer la selección y el vínculo. Retirada, retarget, unlink, rebind o revisión obsoleta rechazan la lectura; nunca se actualiza silenciosamente la selección. Una observación no relacionada del ledger no invalida por sí sola el vínculo. `content: null` conserva `reference_only`, sin hash calculado ni aprobación documental. Los errores no exponen detalles internos del lector o transporte.

El contrato selecciona evidencia y **no concede acceso**. La autorización SQL, sus locks, retirada/caducidad y permisos siguen en el servicio llamador. El owner debe ser código confiable del servidor; no se acepta una selección desde headers/body del navegador. No se suministra implementación del owner real ni transporte remoto.

El servicio base de propuestas también corrobora una `quote` que ya figure en el vínculo activo: ID documental, versión y digest deben coincidir con el documento verificado antes de asociarlo, leer su revisión o aprobarla. Una contradicción devuelve `BINDING_MISMATCH`, `CANONICAL_VERSION_MISMATCH` o `CANONICAL_CONTENT_MISMATCH` y revierte la operación. Así, las composiciones existentes tampoco pueden revisar bytes contradictorios por omitir el adaptador. Un vínculo sin `quote` conserva su comportamiento anterior; metadata canónica sin contenido sigue siendo `reference_only` y no permite aprobación. No se crea ni completa automáticamente ese vínculo.

## Pruebas y límites

Las pruebas sintéticas componen el adaptador con el servicio de propuestas, ledger y proveedor existentes. Incluyen IDs/procedencia/namespace/revisión contradictorios, hash y versión obsoletos, referencia sin contenido, getters/campos de autoridad, cambios durante I/O y permisos de lectura. La integración PostgreSQL importa por `publishFromProvider`, recupera el historial cifrado al recrear el servicio, comprueba replay idempotente, rechazo de bytes alterados y retirada de sesión antes de consultar el proveedor.

Con el PostgreSQL sintético local ya iniciado, la prueba reproducible del contrato es:

```
node --import tsx --test tests/office/canonical-proposal-provider.test.ts
```

El workflow de Office añade únicamente la nueva rama a sus dos allowlists de verificación. Conserva permisos de repositorio de lectura, servicios locales sintéticos y artefactos PNG. El workflow staging permanece intacto y sólo responde a develop/manual; no se usa ni dispara. Las rutas/entrypoints normales no instalan el adaptador. No hay fetch, preview automático, importación automática, nueva ruta HTTP, credenciales, cambio de permisos, envío, aceptación del cliente, merge o despliegue. Payments continúa fuera de alcance.
