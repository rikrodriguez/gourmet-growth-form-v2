# Evidencia mínima para vincular Quote Studio con un caso

Revisión cloud del 2026-10-21 sobre PR18, base
`be1de315aebc029347ddfa0d8c4e95fb7f4f2825`. Se recuperó primero el resultado
existente: CI `39260036000`, completed/success, 24 pasos correctos. Este análisis
no ha recuperado el productor ni valida una integración productiva.

## Entrega pendiente, sin datos de clientes ni credenciales

| Evidencia concreta | Campos y regla que debe demostrar | Puerto existente |
| --- | --- | --- |
| Repositorio/ruta y commit, o snapshot saneado del productor; funciones de carga, guardado y exportación | Qué identifican `load.id`, `load.revision` y `state.projectId`; cuándo cambia cada uno; qué exportación corresponde a una revisión. El sobre `{ok,id,revision,state}` no declara por sí solo esos significados. | [Contrato documental](../src/office/backend/external-proposal-provider.ts#L9) y [caracterización](../tests/office/quote-studio-characterization.test.ts#L31). |
| Función server-side que lee una relación ya autorizada, con una muestra saneada de esa relación | `target.{leadId,eventId,proposalId}`; CRM `source.{accountId,boardId,itemId}`; `references.{lead,event,proposal}.{sourceSystem,boardId,itemId}`; `scope.{organizationId,workspaceId,mode}` y `bridgeScope.{organizationId,actorId,partition}`. Debe declarar namespaces, cardinalidad y sustituciones; no unir por plantilla, URL, nombre o fecha. | [`ExistingCanonicalProposalLinkOwner.readExistingLink(target)`](../src/office/backend/canonical-proposal-provider.ts#L11). El llamador fija `expected` independientemente del resultado. |
| Selección canónica vigente y su procedencia | `binding.{id,revision,digest}` y versiones de tipo `lead/event/quote` de ese vínculo; cada versión incluye referencia completa, `sourceVersion`, `contentDigest` y `provenance.{evidenceRef,observedAtMs}`. La relación debe seguir vigente al acabar la lectura de bytes, sin elegir automáticamente otro vínculo. | [Comparación con ledger y relectura](../src/office/backend/canonical-proposal-provider.ts#L81), [tipos versionados](../src/office/canonical-bridge-contracts.ts#L7). |
| Contrato de exportación y muestras saneadas que preserven las relaciones y bytes relevantes | Dos documentos distintos con la misma plantilla y dos revisiones de uno; para cada exportación: ID, versión inmutable, formato/media type y encoding declarados, bytes exactos, longitud y SHA-256. Debe indicar cómo se fija y vuelve a leer la misma versión. La versión editorial, `sourceVersion`, revisión del binding y revisión CAS del expediente son conceptos separados. | [Versión y digest exactos](../src/office/backend/canonical-proposal-provider.ts#L100), [bytes permitidos](../src/office/backend/external-proposal-provider.ts#L32). No existe conversor de estado ni lector PDF/HTML binario. |
| Función que declara la procedencia CRM y los efectos de leer/exportar | Para `historicalLink`: `provenance.{accountId,boardId,itemId,columnId,updateId,observedAt,changedAt,originalValueType}` y `originalUrl` nullable. Debe explicar qué columna/registro escribió el productor y cuándo; también si cargar/exportar escribe CRM. La procedencia documental debe corresponder al CRM esperado y tener categoría `quote`, sin cuarentena. | [Procedencia histórica](../src/office/backend/lead-link-history.ts#L44), [verificación](../src/office/backend/external-proposal-provider.ts#L42). Los tests locales actuales no prueban efectos de un productor CRM real. |

La fuente Growth UUID y el item CRM son identidades distintas. La documentación
previa acredita en otra línea `lead_id → monday_item_id`, pero no el enlace a
evento de catering y documento. `growth_v2.events.event_id` identifica telemetría;
no debe usarse como evento de catering. Los IDs del contrato Office son tokens
opacos; que un valor pase su sintaxis no acredita su relación con Growth.
Véase [fuente demostrada y pendiente](canonical-proposal-link.md#fuente-demostrada-y-dato-pendiente).

Calculator `text_mm1kdqqb` y Quotes `text_mm1mkvn` están reconocidas como
procedencia histórica, no como una traducción automática de IDs. Una URL no
concede lectura. La clave `originalUrl` es obligatoria, pero su valor puede ser
`null` o cadena vacía si la categoría y la procedencia son correctas. No se exige que el
productor entregue secretos o URLs firmadas para resolver este análisis.

## Dos límites distintos que debe satisfacer la exportación

El contrato actual admite exclusivamente proveedor `synthetic`, modo `test` y
texto UTF-8 exacto de hasta **262144 bytes**, inclusive. Calcula su SHA-256
localmente; no acepta el hash suministrado por el productor como sustituto de los
bytes. `content: null` conserva `reference_only` y no permite aprobación
documental. Los **579815 bytes** citados del payload del editor se atribuyen al
extracto de la tarea anterior; no se han recuperado aquí ni demuestran el tamaño
del contenido exportado. Tampoco se ha verificado de nuevo aquel hilo.

Además, el [repositorio durable](../src/office/backend/external-proposal-postgres.ts#L47)
limita el JSON completo del expediente a **524288 bytes antes de cifrar**. Guarda
los documentos y sus snapshots de revisión: importar un texto válido de 262144
bytes puede caber y su asociación posterior exceder el agregado. La regresión
añadida a [la suite existente](../tests/office/quote-studio-characterization.test.ts)
fija ese rechazo `PROPOSAL_STORE_INVALID` (409), sin retirar el documento ya
importado ni alterar historial, recibos, aprobaciones, ciphertext, auditoría o
ledger después del import. No se ha aumentado ninguno de los límites.

Por tanto, la evidencia debe permitir comprobar bytes y JSON del expediente
durante el ciclo de importación/revisión, incluido su historial; el límite de
contenido aislado no garantiza que todas las operaciones durables quepan. Esto
es una frontera sintética reproducible, no una medida de una exportación real.

## Autoridad independiente para conectar el host

Resolver identidad y bytes no concede permisos. Para conectar el host también
falta identificar el módulo y función que leen su sesión comercial existente:
`proof.{sessionToken,csrfToken}`, `scope`, `actorId`, `target` y `expiresAtMs`, con
semántica de revocación/caducidad compatible con la autoridad SQL. Se necesita
su contrato saneado, nunca el valor de los tokens. El [puerto preparado](../src/office/backend/proposal-host-session.ts#L9)
no emite sesiones ni amplía grants; Basic, DEMO, una sesión de visitante o `ok:true`
no acreditan al aprobador. Aprobar sigue siendo un comando interno independiente.

## Qué termina aquí

Verificación local de este corte: caracterización **5/5** y `npm run test:office`
**1202/1202**, sin fallos ni omisiones; referencias locales y `git diff --check`
correctos. El documento tuvo revisión independiente. Son resultados sintéticos,
no validación del productor, de datos reales o de efectos CRM.

Las pruebas genéricas de identidad, scope, namespaces, versión, hash, cambios
durante I/O y permisos ya existen; se conservan. Sólo se añade la regresión del
límite agregado que faltaba. No hay fuente nueva para elegir un mapping real,
traducir revisiones o instalar un proveedor; no se repiten barridos históricos ni
se abre hosting/CRM para suplirla. Las rutas normales siguen cerradas y los
puertos continúan TEST_ONLY. Sin cambios de producción, precios, contratos,
permisos, contactos, merge o despliegue. Payments de Gourmet sigue pausado.
