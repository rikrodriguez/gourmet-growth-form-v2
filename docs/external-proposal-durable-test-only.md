# Propuestas externas sintéticas: persistencia y aprobación atómica

Corte opt-in sobre PR5 `92e44cb6bef588221d20a38bbbd975a72f61f672`. Conserva su parser estricto, serialización canónica compartida, validación del hash completo y copia separada para revisión. No añade UI, otro editor, proveedores reales ni rutas en los servidores normales.

## Reproducción y garantía nueva

Se reprodujo el problema antes de implementar este corte con el servicio y fixture de PR5: durante la tercera llamada a resolveAuthority de approve (la última antes de escribir), la fuente v1 cambió a v2. Se guardaron revisión 2 y una aprobación de v1; la respuesta posterior sólo devolvió obsolete. Releer varias veces sin mantener los locks de las fuentes no constituye una revisión atómica.

`createDurableTestProposalService` compone el servicio existente dentro de `PostgresQuoteAccessRepository.run`. Esa composición, y no el servicio de memoria usado por la demo anterior, proporciona la nueva garantía. No cambia el comportamiento de consumidores existentes ni afirma que el acceso directo al servicio con dependencias de memoria sea atómico.

## Una transacción, un PoolClient

El llamador suministra el Pool, vault existente y prueba de una sesión ya autenticada. La fábrica no crea roles, cuentas, grants, credenciales ni schemas. El caso es un target fijo del servidor con leadId, eventId y proposalId explícitos. La asignación canónica existente determina la única cadena autorizada; el grant de ese evento se verifica con el repositorio de acceso existente. No se concede acceso a otros historiales por nombre, sesión externa o rol sin grant.

La transacción toma los locks en este orden:

1. Sesión, usuario, membresía, asignación y grant: repositorio existente, con vencimiento temporal y plazo de operación comprobados hasta commit.
2. Caso y fuente sintéticos: advisory lock para la creación ausente y fila `FOR UPDATE`, mantenidos hasta commit/rollback.
3. Brief existente: fila de cotización `FOR SHARE`, incluyendo cambios de destinatario.
4. Ledger canónico: adaptador existente con `transaction?: PoolClient`. Al omitir esa opción conserva su comportamiento; al usarla no inicia, confirma, revierte ni libera la transacción del llamador y mantiene bloqueada la fila leída.

Documento, mapping, versiones del vínculo y brief se leen a través de ese mismo cliente. Un publicador concurrente de documentos, editor de brief, cambio de vínculo o retirada de grant espera al fin de la revisión. Si el cambio ocurre antes, la revisión se rechaza; si ocurre después del commit, invalida la aprobación histórica al volver a consultar. No se afirma que una respuesta mantenga vigencia después de un cambio posterior al commit.

El CAS del caso detecta también una alteración realizada en el mismo cliente durante la última lectura de autoridad. La regresión inyecta v2 exactamente en ese punto: se rechaza PROPOSAL_SOURCE_CHANGED y el rollback conserva cero aprobaciones, el recibo previo y su auditoría. La alteración inyectada dentro de esa misma transacción también se revierte.

## Persistencia cifrada y recuperación

`PostgresExternalProposalRepository` utiliza el vault existente con AAD que liga clave del caso y revisión. Reutiliza el layout SQL ya revisado de agregado cifrado y auditoría inmutable de `005_event_quotes.up.sql`, sustituyendo sólo el namespace y prefijo físico de clave en un schema `proposal_test_<uuid>`. No acepta EventQuoteRecord ni convierte el documento en cotización calculada. Ninguna migración existente se modifica ni aplica desde el arranque normal.

El caso cifrado conserva ámbito test, actor, target, mapping, todas las versiones sintéticas del documento y el ProposalRecord existente con snapshots, decisiones y recibos. Cada append preserva prefijos históricos y añade hashes de auditoría en la misma escritura SQL. Una versión de proveedor no puede reescribirse. Publicar de nuevo la misma versión/contenido es un no-op. Los recibos exactos se recuperan sin duplicar la decisión al reintentar una operación cuyo resultado no se recibió.

El bootstrap explícito sólo admite un schema de prueba fresco en loopback. Límites del agregado reutilizado: 100 generaciones SQL (incluidas publicaciones), 20 versiones de documento y 512 KiB de texto JSON total. Se rechaza superar los límites; no hay compactación ni borrado de historial. El uso de locks por agregado es deliberadamente conservador para este corte pequeño.

La prueba de recuperación abre dos procesos Node nuevos, con Pool, servicio, repositorio y revisión de acceso nuevos. Recupera una aprobación vigente, documentos y recibos exactos, y después el historial obsoleto tras publicar v2. El proceso recibe sólo configuración de fixtures de loopback; no depende de maps u objetos del proceso que escribió. La clave de vault es la fixture sintética ya utilizada en las pruebas existentes, no una credencial comercial.

## Validación y pendientes

```
npm run office:db -- start
node --import tsx --test tests/office/external-proposal-durable.test.ts
npm run test:office
```

Las pruebas usan schemas aleatorios y datos ficticios; sus inserciones de autoridad representan permisos ya existentes. La composición no contiene métodos para concederlos. Se cubren proceso nuevo, dos pools concurrentes, publicación durante la última lectura, locks de documento/brief/vínculo/grant, revocación previa, expiración después del write SQL, replay, inmutabilidad, cifrado, aislamiento y propiedad de commit/rollback del puente compartido. El CI conserva las regresiones de PR5 y de los consumidores existentes.

Pendiente: una composición de navegador/HTTP durable específica si se autoriza, revisión operativa del almacenamiento y ciclo de claves para cualquier uso real. No se conecta Hostinger, Monday, Gmail, Voice o Payments ni se activan rutas comerciales. Persistencia sintética no equivale a integración comercial, envío, aceptación del cliente o confirmación operativa. Sin merge ni despliegue.
