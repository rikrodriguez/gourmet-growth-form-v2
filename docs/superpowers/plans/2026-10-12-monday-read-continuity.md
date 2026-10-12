# Monday Read Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preparar lectura Monday útil, acotada y reanudable, con renovación automática desactivada.

**Architecture:** Capacidades y disponibilidad compartidas; cliente de lotes con checkpoints privados; servicio con checkpoints cifrados y CAS; portal que conserva procedencia y cobertura. Scheduler independiente que usa el refresh existente y permanece desactivado.

**Tech Stack:** TypeScript, Fastify, React, Node test, Playwright, PostgreSQL CAS y MondayVault existente.

**Spec:** [../../monday-read-continuity-spec.md](../../monday-read-continuity-spec.md)

## Global Constraints

- Cinco IDs de metadata, cuatro IDs de registros; Deals excluido.
- Exactamente boards:read, updates:read, me:read; sin cambios de mappings.
- Página25/lote4/ítems100; máximo40 páginas/1000 ítems por recorrido explícito.
- Cursor privado cifrado; TTL5min ligado al grant y al mapping.
- Owner/CSRF/TLS/state/nonce/PKCE intactos.
- Scheduler desactivado; pruebas sin servicios reales. Autorización posterior: publicación y despliegue ordinario sólo staging tras controles y revisión, hasta 2026-10-12 14:00 UTC. Sin activación, secretos, grants ni cambios de scopes/allowlist.
- Expiración desplegada relevante: 2026-10-13 03:19 UTC.

## Review Focus

- Continuación manipulada, repetida o de otro tablero/tipo: rechazar antes del proveedor.
- Refresh/disconnect/reconfiguración durante lectura: invalidar checkpoint y no mezclar generaciones.
- Rate limit tras páginas válidas: conservar cobertura y espera, sin reintento automático.
- Campo no mapeado frente a nulo/oculto: estados distintos; ninguna inferencia de pago.
- Reinicio o dos schedulers: un único refresh; resultado incierto no se repite.

---

### Task 1: Capacidades y procedencia

**Files:** crear `src/office/monday-board-catalog.ts`, `src/office/monday-provenance.ts`, `tests/office/monday-capabilities.test.ts`.

**Interfaces:** `getMondayBoardCapabilities(mapping, mappingVersion, enabled)` devuelve capacidades de los cinco IDs sin modificar mapping. `getMondayItemAvailability(item, capability)` devuelve estados de los siete campos comerciales. `getMondayReadCoverage(result)` conserva cobertura y total desconocido.

- [x] Escribir RED para Deals bloqueado, arrays vacíos, nombres/IDs, valores vacíos, ocultos y no consultados.
- [x] Implementar funciones puras con datos congelados y errores fijos para contratos inválidos.
- [x] GREEN y revisión del alcance de datos; ninguna consulta real.

### Task 2: Cliente de lotes

**Files:** modificar `src/office/backend/monday-read.ts`, `tests/office/monday-read.test.ts`.

**Interfaces:** `MondayReadCheckpoint`; `MondayReadBatch<T> = { result, checkpoint }`; `readBoardBatch(input, checkpoint?)` y `readUpdatesBatch(input, checkpoint?)`. Mantener métodos antiguos y consultas de allowlist.

- [x] RED para 100+ítems, continuidad, deduplicación entre lotes, ciclo y expiración.
- [x] Implementar checkpoint interno ligado a actor/tablero/mapping/token y presupuesto acumulado40/1000.
- [x] Pruebas de 429 y espera, respuesta incompatible y ausencia de cursor en resultado público antiguo.
- [x] GREEN; confirmar Deals0requests y tres scopes exactos.

### Task 3: Servicio y API

**Files:** modificar `src/office/backend/monday-oauth.ts`, `monday-http.ts`, `monday-runtime.ts` y sus pruebas.

**Interfaces:** lectura opcional con `continuation`; respuesta enriquecida con `paging`; capacidades desde cliente validado. Claves privadas fijas por propietario/tablero/tipo, hash del handle y AAD existente.

- [x] RED para handle arbitrario, replay concurrente, mismatch de grant/tablero/tipo/mapping y nonce/CSRF ausentes.
- [x] Cifrar checkpoint, consumir handle mediante CAS, rotar handle después del lote y conservar TTL original.
- [x] Actualizar lastReadAt sólo tras página confirmada; serialización nunca incluye cursor/token.
- [x] GREEN HTTP, servicio y durabilidad PostgreSQL; refrescar mocks compatibles sin ampliar acceso.

### Task 4: Renovación desactivada

**Files:** crear `src/office/backend/monday-renewal.ts`, `tests/office/monday-renewal.test.ts`; wiring desactivado en runtime y cierre del servidor.

**Interfaces:** `createMondayRenewalScheduler({ enabled:false, service, store, vault, clock, timers? })` expone start/stop/tick y estado seguro.

- [x] RED para disabled0effects, margen15min, concurrencia, reinicio, backoff y incertidumbre terminal.
- [x] Implementar claim CAS cifrado y política60/120/240/hasta900s, sin rutas ni flag de activación.
- [x] GREEN con servicio real y proveedor sintético; comprobar pareja de tokens guardada atómicamente y sin replay.

### Task 5: Portal

**Files:** modificar `src/office/MondayOwnerPage.tsx`, `tests/office-e2e/monday-owner.spec.ts`.

**Interfaces:** capacidades, disponibilidad y paging definidos arriba; continuar usa POST con handle opaco y CSRF.

- [x] RED desktop/mobile para nombres, Deals/arrays vacíos, estados de campo y continuidad por acción.
- [x] Validar capacidades del servidor; separar botones comerciales y metadata de actualizaciones.
- [x] Conservar lote y cobertura acumulada sin duplicados; mostrar bloqueo/espera/caducidad y total desconocido.
- [x] Mostrar renovación automática desactivada y mantener renovación manual.
- [x] GREEN completo de Monday UI, tipos y builds.

### Task 6: Cierre del lote

- [ ] Ejecutar suite backend completa, UI pertinente y pruebas de PostgreSQL incluidas.
- [ ] Revisar diff completo con revisor independiente: permisos, AAD/CAS, privacidad, costos y renovación desactivada.
- [ ] Guardar evidencia y commit; publicar por fast-forward al branch staging existente y desplegar la revisión exacta sólo después de CI completo y revisión. Sin cambios de grants ni scheduler activo.
- [ ] Reportar funcionamiento preparado frente al runtime desplegado y la expiración pendiente.
