# Recuperación de revisiones internas de abastecimiento

Candidato comprobado: PR 17, `20199a68f01050c21dd194d53dbd5238a17a2ef6`.
La retirada de asignación interna ya está incluida desde `bf41d9e` y no se
reimplementa. En este cloud pasaron las 49 pruebas previas de supply, incluidas
compatibilidad con asignaciones sin revisión, replay y carreras de PostgreSQL.
El recorrido de retirada y sustitución también pasó en Chromium desktop y móvil
320, conservando la reserva hasta la retirada explícita y una sola reserva activa
al reemplazarla.

## Fallo vigente reproducido

1. Validar menú, construir lista, elegir opción A y preparar su revisión interna.
2. Rechazar o cancelar la revisión pendiente. También ocurre si primero se elige
   otra opción B y después se cancela/rechaza la revisión histórica pendiente A.
3. Volver a elegir A con una nueva clave de comando.

Antes de corregir, el caso directo conservaba la opción terminal; el histórico
recuperaba el mismo registro y lo dejaba `stale`. Ambos conservaban la aprobación
terminal. Preparar la revisión de nuevo devolvía `replayed: true`, y aprobarla
fallaba con `APPROVAL_TERMINAL`. La UI tampoco podía preparar otra revisión porque
la opción ya tenía `approvalId`.

Cuatro regresiones (rechazar/cancelar × elección actual/histórica) fallaron en el
candidato con `an explicit new choice must not reuse a terminal review`: ID real
y esperado eran `supply-option-d859fe3d74baab7ac7356d8b`. Evidencia local de la fase
roja: `/tmp/gourmet-terminal-red.log`; reproducción adicional:
`/tmp/gourmet-supply-cancel-repro.mts`.

## Corrección acotada

`choose_purchase_option` sólo reutiliza una revisión pendiente o aprobada vigente.
Una nueva elección explícita después de rechazo, cancelación o invalidación crea
otro ID con revisión creciente y aprobación pendiente. La revisión se deriva del
máximo previo para la misma opción, menú y lista. Los retries de una elección
pendiente siguen reutilizando el mismo registro bajo la transacción existente.

Se mantienen los snapshots, digests, contextos, comandos, eventos y decisiones de
aprobación anteriores. Los replays devuelven el estado actual y no autorizan la
nueva elección. La nueva aprobación interna sigue siendo una acción humana
separada. No cambian schema, migraciones, endpoints ni interfaz de comandos.

## Verificación

Las regresiones se añaden a las suites existentes:

- Unitarios: las cuatro rutas, identidad/revisión nuevas, aprobación obligatoria,
  conservación del contexto anterior, replay y ausencia de efectos externos.
- PostgreSQL: payload terminal previo, reapertura, pools independientes, carreras
  de elección/revisión y conservación de eventos/digests anteriores.
- Navegador: recuperación desde Logística tras recarga, revisión nueva, aprobación
  separada y conservación de la cancelación anterior, en desktop y móvil 320.

Resultado local: `test:office` **1188/1188**, sin omisiones, y `test:operations`
**99/99**; tipos y ambos builds correctos. Las cuatro regresiones rojas pasan tras
la corrección. Las cuatro regresiones PostgreSQL también pasan y emiten
`PURCHASE_RECOVERY_EVIDENCE` con IDs de opción/aprobación nuevos y revisión 2.
El recorrido de recuperación en navegador pasa en ambos tamaños y emite
`PROCUREMENT_REVIEW_RECOVERY_EVIDENCE`; conserva la aprobación cancelada y exige
la nueva aprobación tras recargar. Capturas:
`test-results/dashboard-visual/office-*-procurement-recovery-{pending,approved}.png`.
Logs locales: `/tmp/gourmet-office-full.log`, `/tmp/gourmet-operations.log`,
`/tmp/gourmet-procurement-pg.log` y `/tmp/gourmet-procurement-browser.log`.

```sh
npm run office:db -- start
node --import tsx --test tests/office/supply-workflow.test.ts tests/office/supply-postgres.test.ts tests/office/canonical-bridge-ci.test.ts
npm run test:office:e2e -- tests/office-e2e/supply-workflow.spec.ts
npm run typecheck
npm run build
npm run office:build
```

El workflow de verificación se habilita únicamente para
`fix/supply-current-candidate-20261018`, con `contents: read`, fixtures locales e
imagen Docker local. El workflow de publicación de Hostinger continúa limitado a
`develop` o dispatch explícito. El cambio se publica en una rama separada y PR
borrador sobre PR 17; no requiere merge ni despliegue. Payments permanece pausado;
no se modifican credenciales, permisos, Monday ni contrataciones externas.
