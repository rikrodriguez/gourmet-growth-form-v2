# Retirada explícita de asignación interna DEMO

Base PR9 verificada: `4be5efadc34ae02b02467d6862087705eecd5147`. Antes de corregir se reprodujo: candidato A `unavailable`, selección A `stale` pero `assignedDemo: true`, reserva `assigned_demo`; asignar B ya aprobado falla con `SUPPLY_CASE_ALREADY_ASSIGNED`. Evidencia local: `/tmp/gourmet-supply-withdraw-reproduction.json`.

El cambio conserva la reserva al cambiar evaluación/disponibilidad/condiciones. Una selección obsoleta muestra «Requiere revisión» y deja explícito que la reserva continúa activa. La retirada requiere una acción humana separada, motivo y revisión exacta; no contacta al chef ni cancela una contratación real.

Se reutilizan `SupplyOperation`, `executeOfficeCommand`, `/office-api/commands`, autorización de suppliers y la transacción/persistencia del agregado existentes:

```
{ action: 'draft', functionId: 'suppliers', caseId, idempotencyKey,
  supply: { step: 'withdraw_assignment', assignmentId, revision: 1, reason } }
```

El motivo es obligatorio, hasta 500 caracteres, sin controles. La reserva cambia de activa/revisión 1 a `withdrawn_demo`/revisión 2, terminal. Se conservan ID, selección/revisión, aprobación, ventana, fecha y evidencia de asignación. `withdrawal` agrega motivo, fecha, actor DEMO y evidencia propia; el historial y command event existentes registran la acción. No se borra ni sobrescribe la aprobación, snapshot o digest de la selección original.

La selección retirada queda stale y sin asignación activa. Si se revisan de nuevo exactamente los mismos hechos, se crea otra selección con ID/revisión nuevos y aprobación pendiente, conservando la anterior. Para otro candidato se usa su selección/aprobación habitual. Sólo reservas activas participan en el bloqueo por caso y solapamiento global de candidato. Se mantiene una sola asignación activa por caso; retiradas históricas no bloquean sustitución ni reservan ventana.

El replay de una clave anterior responde con el estado autoritativo actual, sin ejecutar otra vez la operación. Así, repetir el antiguo assign, approve o withdraw no reactiva al chef ni retira a su sustituto. Cambiar motivo con la misma clave produce conflicto; una retirada nueva con revisión vieja falla. No existe acción de reactivación: se requiere otra selección aprobada.

Compatibilidad: `schemaVersion: 1` continúa vigente. Una reserva anterior sin `revision` equivale a revisión 1. No se inserta ese campo en el payload al leer o inicializar; sólo la proyección del cliente lo normaliza. No hay migración, reescritura de comandos/digests ni eliminación de eventos. El cliente valida estado, revisión y metadata de retirada y rechaza múltiples reservas activas del mismo caso.

Pruebas añadidas al flujo existente, sin otro endpoint/harness:

- Unitarios: reproducción corregida, motivo y revisión, permisos existentes, caso ajeno, evidencia/digest conservados, replay antiguo, revisión nueva de hechos idénticos, compatibilidad y payload contradictorio.
- PostgreSQL: pools independientes y reapertura, payload de asignación anterior sin revisión, igualdad de comandos/digests y eventos previos; retries concurrentes de retirada; dos sustituciones aprobadas compiten y sólo una se asigna; disponibilidad no libera solapamiento y retirada explícita permite recuperación/retry desde otro caso.
- Navegador desktop y móvil 320: recorrido completo por la pantalla existente, asignación A, indisponibilidad, aviso de revisión, recarga con reserva aún activa, retirada con motivo y evidencia, aprobación/asignación B, nueva recarga y una sola reserva activa. Capturas `test-results/dashboard-visual/office-*-supply-{requires-review,withdrawn,replacement}.png`; log `SUPPLY_WITHDRAWAL_EVIDENCE`.

```
npm run office:db -- start
node --import tsx --test tests/office/supply-workflow.test.ts tests/office/supply-postgres.test.ts
npm run test:office:e2e -- tests/office-e2e/supply-workflow.spec.ts
```

Todo permanece sintético y DEMO. La incidencia y aceptación externa del proveedor mantienen su evidencia independiente. Payments, permisos, credenciales, APIs de proveedores, servidores comerciales y workflow de publicación de form2 no cambian. Publicación limitada a rama/PR borrador y CI de lectura; sin merge ni despliegue.
