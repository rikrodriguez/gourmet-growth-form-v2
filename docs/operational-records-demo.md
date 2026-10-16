# Registro operativo: exclusivamente DEMO

Base: PR10 `bf41d9ec071bf708dd48b0d1cf11e4c8f2bd9c62`. Este corte amplía Office con recepción, hitos, incidencias, acuse, resolución y cierre **de ensayo**. No está habilitado comercialmente y no acredita preparación, entrega, aceptación de proveedor ni cierre de un evento real.

## Requisitos recuperados y reutilización

Fuentes leídas: **Gourmet OS — Especificación de diseño v1**, 3 de octubre de 2026, §§4–6,7–9; **Gourmet OS — Plan de implementación v2**, T5/T6 y decisiones pendientes, disponibles en la Biblioteca. El rector exige entrega/incidencia/responsable/resolución, impide cerrar con pendientes, conserva estados independientes y prohíbe que respuestas tardías regresen hechos silenciosamente. La autorización vigente excluye Payments y operación real; las secuencias históricas financieras del rector no se activan aquí.

El [inventario](agent-capability-inventory.md) y la [matriz](automation-traceability.md) describían supervisión/recepción/cierre como faltantes. Este corte sustituye esa clasificación sólo para el ensayo local tipado que se documenta aquí. La retirada de reservas de PR10 se conserva.

Se reutilizan `OfficeState`, el expediente `OfficeCase`, el evento y dependencias Supply, `/office-api/commands`, permisos de sesión/caso/función, PostgreSQL, receipts de comandos e historial append-only. Logística muestra recepción/hitos; Calidad muestra incidencias/resoluciones/cierre en el workspace existente. No hay otro backend, worker, endpoint, editor de propuestas ni harness. Los vínculos comerciales/canónicos no se fabrican: estos casos conservan sus IDs sintéticos `caseId` y `eventId`; no se deduce un lead por nombre ni se afirma una conexión comercial con los leads reales.

## Política y recorrido del fixture

La política inmutable `ops-policy-synthetic-v1` requiere elección explícita desde Logística. Permite **sólo el ensayo** con una reserva interna `assigned_demo` vigente, selección revisada, menú/lista/opción aprobados, recepción completa y cuatro comprobaciones ficticias: preparación, montaje, servicio y entrega. El mismo actor DEMO puede registrar y revisar el ensayo; esto no establece firmantes ni segregación de funciones productivas. No contiene reglas alimentarias ni SLA.

Sin política, el cierre explica: «Falta política operativa; no se infieren mínimos ni firmante». No se admite cargar una política comercial desde el navegador. Retirar la política mantiene bloqueado el cierre y conserva el anterior como pendiente de nueva revisión.

1. Usar la asignación y abastecimiento existentes; aprobar compra sigue sin emitir pedido.
2. Registrar uno de tres comprobantes server-owned: completo, parcial o referencia sin documento. El completo vincula cantidades a la opción/revisión exactas. Parcial y `reference_only` bloquean cierre; la referencia no tiene contenido ni hash documental.
3. Confirmar cada hito con su contenido de fixture. Son observaciones del ensayo, no una orden de iniciar servicio ni un permiso para marcar `readyForExecution`.
4. Registrar una incidencia tipada con descripción, responsable y hito afectado del fixture, o indicar «Evento general». El vínculo se conserva en el journal y tras recarga; los registros anteriores sin hito siguen siendo generales. Estados: `open` → `acknowledged` → `resolved_demo`; una resolución necesita texto y contenido verificable de fixture. Puede resolverse sin acuse previo; no se impone un proceso comercial inexistente. La evidencia obsoleta exige otra resolución.
5. Calidad revisa el estado exacto y confirma el cierre de ensayo. Requiere los permisos ya existentes de Calidad **y** Logística para el caso. No se crean grants ni identidades. Una incidencia abierta, recepción incompleta, hito obsoleto, falta de reserva/política o abastecimiento vencido bloquea la decisión.

La vista de cierre distingue `blocked`, `review_ready`, `closed_demo` y `stale`. No implementa los estados de autorización de ejecución real del rector ni cambia `readyForExecution`. Un registro posterior al cierre o una dependencia cambiada deja el cierre anterior como `stale`, recuperable en historial; se necesita una nueva decisión explícita. El cierre financiero está fuera de alcance. Los flags Supply `externalHired`, `externalOrdered`, `externalPaid`, `externalReceived` siguen falsos: los comprobantes nuevos son observaciones sintéticas independientes de esos hechos externos.

**Preparar o aprobar un borrador de Calidad no registra, reconoce, resuelve ni cierra una incidencia.** Las operaciones del registro no generan mensajes ni aprobaciones de email.

## Identidad, versiones, evidencia y recuperación

`operational` es una operación tipada bajo el `action: draft` existente, con evento, revisión esperada y digest de dependencias. No admite contenido documental, actor, timestamps, estados ni hashes suministrados por el cliente. Cada paso incrementa la revisión y agrega un registro con actor, evento, operación, fechas, contenido de fixture, SHA-256 de sus bytes UTF-8 y digest canónico del registro. Máximo 200 registros por caso; el límite se explica con `OPERATIONAL_RECORD_LIMIT` y no trunca historia ni descarta evidencia.

El digest de dependencias incluye identidad/ficha del caso, cierre humano, evidencia de proveedor, evento, reserva/selección/candidato vigente y menú/lista/opción. No incluye ni modifica Payments. Cambios de ficha/brief representado, fecha/ventana, menú, opción o retirada/sustitución invalidan confirmaciones anteriores. El cierre exige además el digest exacto de toda la revisión. No hay fetch o preview de URLs ni proveedor documental remoto.

La vigencia reutiliza `assertSupplyReviewCurrent` y la aprobación exacta existente, incluida su validez en el núcleo. Se contrastan ventana, revisión y aprobación de la reserva con el evento/selección actuales. Renovar recepción o hitos después de mover la ventana del evento no rehabilita una selección anterior: requiere resolver la reserva mediante el flujo Supply existente. La revisión independiente encontró ese caso y su regresión pasó tras corregirlo.

La transacción existente serializa pasos, revisión y registro durable del idempotency key. Repetir la misma clave recupera el estado actual, incluso tras reiniciar el proceso; otro contenido con esa clave da conflicto. Dos operaciones con la misma revisión no pueden aplicarse silenciosamente. El journal, command receipts e historial anteriores no se pueden reescribir. Los agregados antiguos carecen de journal hasta la primera operación; no se reseedean.

La proyección filtra Logística y Calidad por los scopes existentes. El navegador conserva únicamente el intento incierto en su mecanismo existente; recargar y reintentar usa el mismo input. Cambiar de caso no hace que la respuesta pendiente del anterior sustituya el expediente visible.

El lector del contrato también contrasta el estado de cierre con revisión, registro, pendientes, política y resumen del ensayo. Cuando el historial de Calidad está visible, su último cierre debe corresponder al ID, revisión y contexto proyectados. Las vistas filtradas por permisos conservan su validez; no se exige exponer historial de otra función. Una respuesta contradictoria se rechaza como incompatible antes de renderizarla y se conserva únicamente la última lectura confirmada. Esto comprueba coherencia de la respuesta, no autentica un snapshot íntegramente fabricado ni sustituye la autoridad y verificaciones de PostgreSQL/backend.

## Verificación y demostración

Las suites existentes incorporan el recorrido positivo y los límites, con datos exclusivamente sintéticos:

- `tests/office/supply-workflow.test.ts`: política ausente, completo/parcial/reference-only, identidad, hashes, payload estricto, permisos/revocación/caducidad, cambios de dependencias y borrador sin efecto operativo. Parte además del snapshot inicial real de `projectOfficeSnapshot` y cambia sólo `cases[0].operationalWorkflow.closure.status` de `blocked` a `closed_demo`: contrato y adaptador deben rechazarlo. Los cuatro estados legítimos se verifican con scopes de Logística, Calidad y ambas funciones.
- `tests/office/supply-postgres.test.ts`: dos procesos Node con PIDs distintos usan los módulos reales y el mismo agregado; el segundo recupera/reintenta el cierre sin duplicarlo. Pools independientes comprueban carrera cierre/incidencia, append-only y actualización tardía de menú.
- `tests/office-e2e/supply-workflow.spec.ts`: recorrido de UI existente en escritorio/320 px, recarga, aislamiento, recepción no verificable, cierre DEMO, retirada de política y respuesta incierta recuperada tras cambiar de caso. La regresión de respuesta alterada modifica sólo ese estado en la respuesta real de la API del fixture; comprueba error de contrato, conservación del cierre bloqueado, ausencia de comandos/mutación del journal y recuperación legítima tras recarga.

```
npm run office:db -- start
npm run test:office
npm run test:operations
npm run typecheck
npm run build
npm run office:build
npm run test:office:e2e -- tests/office-e2e/supply-workflow.spec.ts
```

Capturas: `test-results/dashboard-visual/office-*-operational-{prepared,incident,closed-reloaded,policy-missing,response-rejected,response-status}.png`, retenidas por el artifact visual del workflow de verificación existente. Logs: `OPERATIONAL_BROWSER_EVIDENCE`, `OPERATIONAL_RESTART_EVIDENCE` y `OPERATIONAL_RESPONSE_VALIDATION_EVIDENCE`. Los resultados y SHA exactos se publican en el PR draft; este documento no afirma conectores o CI no ejecutados.

## Decisiones comerciales pendientes — no son configuración implícita del código

| Decisión pendiente | Consecuencia antes de operación real |
| --- | --- |
| Mínimos por estilo de servicio, alimentos y requisitos aplicables | No se puede declarar un evento real listo con cuatro hitos del fixture. |
| Personas responsables, firmantes, segregación de funciones y aceptación de equipo | El actor DEMO y una reserva interna no acreditan a un responsable/proveedor real. |
| Evidencia manual admisible, autoridad documental y tratamiento de discrepancias | Un comprobante de fixture no se reutiliza como prueba productiva. |
| Prioridades, acuse, escalamiento, SLA y zona/frescura por fuente | No hay promesas de alertas entregadas ni supervisión continua. |
| Cancelación, excepciones de cierre y reapertura comercial | `stale` conserva evidencia y exige revisión; no cancela compromisos reales. |
| Privacidad, conservación e identidad comercial durable | No se habilitan datos reales ni acceso comercial. |
| Criterio y responsable de cierre financiero | Permanece fuera de este módulo y de Payments. |

Los bloqueos de [identidad del host y proveedor documental](proposal-host-provider-integration.md) siguen abiertos. No se consultan Hostinger, Monday, Gmail, Voice, Payments ni proveedores reales. No hay credenciales, contratación, envíos, merge o despliegue.
