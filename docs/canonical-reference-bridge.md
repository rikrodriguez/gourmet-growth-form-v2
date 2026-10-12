# Puente preparado de referencias canónicas

El módulo `src/office/backend/canonical-bridge.ts` vincula referencias y versiones explícitas de lead, evento, cotización y factura. No importa registros, elige un tablero principal, activa mappings ni conecta el lector Monday con los casos Office. No guarda valores comerciales, nombres, contactos o contenido de documentos; tampoco deriva métricas o afirma aceptación, cobro, contratación o realización de un evento.

## Frontera de confianza y aislamiento

Cada llamada recibe un `BridgeScope` con `organizationId`, `actorId` y `partition`. El llamador debe obtenerlos de una sesión autenticada y autorizada del servidor: el servicio valida su forma y aislamiento, pero **no autentica al actor ni decide sus permisos**. Nunca se acepta un scope del navegador como autoridad. El agregado y su CAS utilizan el scope completo: son espacios privados por organización, actor y partición; compartir datos entre actores requiere una decisión y un contrato futuros.

El registro `sources` se configura desde código confiable del servidor y declara cada `sourceSystem` y su partición `demo` o `external`. No hay fuentes, particiones ni fallbacks implícitos. Una fuente externa no puede entrar en DEMO ni viceversa. Un llamador autorizado todavía necesita verificar procedencia antes de registrar datos: pertenecer al registro no autentica una observación. Ninguna proyección existente consume automáticamente estos vínculos.

`CanonicalBridgeStore` exige lectura y `compareAndSet` atómicos y valores JSON separados de los objetos del llamador. `PostgresCanonicalBridgeStore(pool, { sources })` utiliza el pool existente y conserva el ledger y su auditoría en un esquema separado. No aplica migraciones, crea conexiones adicionales, importa datos ni cierra el pool del llamador. `MemoryCanonicalBridgeStore` se conserva como referencia para pruebas; el runtime no recurre a memoria si falta PostgreSQL o la tabla preparada.

Cada agregado conserva un ledger de comandos y recibos con digests encadenados; las lecturas reconstruyen y validan sus versiones y vínculos. El límite de preparación es 1000 comandos y 1 MiB de JSON por agregado. Superarlo falla sin escribir ni truncar historial; escalar almacenamiento y retención exige un contrato posterior. Estos digests detectan inconsistencias locales y no autentican la fuente ni protegen frente a un administrador que reescriba todo el ledger.

## Identidad, versiones y procedencia

La identidad estable de una entidad es el triple exacto `sourceSystem / boardId / itemId` dentro del scope. No se busca por título, contacto o semejanza. El servicio devuelve `entityId` y un `id` opaco para cada versión registrada; el tipo `lead | event | quote | invoice` de la entidad queda fijado desde la primera observación.

`sourceVersion` es una revisión opaca explícita; `contentDigest` identifica el contenido normalizado de esa revisión y usa 64 caracteres hexadecimales minúsculos, sin prefijo. El mismo triple y revisión no pueden cambiar de digest ni tipo. Otras revisiones crean versiones distintas, incluso cuando su contenido coincide. Repetir una observación idéntica devuelve la versión original sin reemplazar su primera procedencia (`evidenceRef`, `observedAtMs`, `recordedAtMs`, `recordedBy`).

La revisión y su metadata siguen sin verificar la autenticidad de la fuente. Una huella acredita igualdad/integridad del contenido registrado, no quién lo produjo ni si describe un hecho cierto. `sourceUpdatedAt` y la hora de lectura no sustituyen una revisión estable. Los identificadores y referencias de evidencia deben ser opacos y mínimos: no incluir PII, URLs con secretos o contenido libre.

## Comandos y lectura exacta

- `record_source` registra una versión inmutable con su procedencia explícita.
- `bind` escribe una revisión de la cadena completa: versiones exactas de lead y evento, cotización opcional y factura opcional; una factura requiere cotización. Ningún campo selecciona automáticamente «la última» versión.
- `unlink` añade una revisión con `refs: null`; no borra registros ni historia.
- `revert` añade una revisión que recupera las referencias de una revisión indicada del mismo vínculo. Vuelve a validar los conflictos actuales; no rebobina el agregado ni invalida recibos anteriores.

Todos los comandos requieren `idempotencyKey` y `expectedRevision` de la revisión lógica del agregado, distinta del token CAS interno del store. Los comandos de vínculo también requieren `expectedBindingRevision` y `expectedBindingDigest`; para un vínculo nuevo son `0` y `null`, y los digests posteriores usan el mismo formato hexadecimal sin prefijo. CAS rechaza carreras o revisiones obsoletas. Una clave repetida con otro comando produce conflicto; repetir el comando original devuelve su recibo original, vinculado al scope, incluso después de unlink/revert.

Los vínculos no resuelven ambigüedad eligiendo arbitrariamente. Se rechaza la propiedad incompatible de una cotización o factura entre cadenas; la factura pertenece a la cotización explícita de su cadena. Varias versiones pueden conservarse, pero deben seleccionarse y asociarse de forma explícita. Un conflicto exige corregir referencias o añadir una operación atribuible; no permite unir por coincidencias.

`resolve(scope, sourceVersionId)` busca únicamente esa versión entre los vínculos activos: devuelve un vínculo, `null` si no lo hay y error si hay varios candidatos. `readBinding(scope, bindingId, revision)` exige una revisión exacta, incluso histórica; no sustituye revisiones ausentes por el estado actual. Las revisiones conservan digest, digest anterior, acción, evidencia, actor y fecha.

## Ejemplo exclusivamente sintético

El ejemplo usa un registro DEMO explícito y sólo referencias devueltas por el servicio. Los valores son inventados. La autenticación y la autorización no forman parte de este ejemplo local.

```ts
import { CanonicalBridge, MemoryCanonicalBridgeStore } from '../src/office/backend/canonical-bridge';
import type { BridgeEntityKind, BridgeScope, BridgeSourceVersion } from '../src/office/canonical-bridge-contracts';

async function syntheticExample() {
  const sourceSystem = 'fixture:bridge-example';
  const scope: BridgeScope = {
    organizationId: 'fixture-org', actorId: 'fixture-actor', partition: 'demo',
  };
  const bridge = new CanonicalBridge(new MemoryCanonicalBridgeStore(), {
    sources: [{ sourceSystem, partition: 'demo' }], clock: () => 1_800_000_000_000,
  });
  let revision = 0;
  async function record(kind: BridgeEntityKind, hex: string): Promise<BridgeSourceVersion> {
    const receipt = await bridge.execute(scope, {
      action: 'record_source', idempotencyKey: `fixture-record-${kind}`, expectedRevision: revision,
      kind, reference: { sourceSystem, boardId: `fixture-${kind}-board`, itemId: `fixture-${kind}-1` },
      sourceVersion: 'fixture-revision-1', contentDigest: hex.repeat(64),
      provenance: { evidenceRef: `fixture-proof-${kind}`, observedAtMs: 1_800_000_000_000 },
    });
    revision = receipt.revision;
    if (!('entityId' in receipt.recorded)) throw new Error('Expected source version');
    return receipt.recorded;
  }
  const lead = await record('lead', 'a');
  const event = await record('event', 'b');
  const quote = await record('quote', 'c');
  const invoice = await record('invoice', 'd');
  const bindingId = 'fixture-chain-1';
  const bound = await bridge.execute(scope, {
    action: 'bind', idempotencyKey: 'fixture-bind-1', expectedRevision: revision,
    bindingId, expectedBindingRevision: 0, expectedBindingDigest: null,
    evidenceRef: 'fixture-explicit-link-1',
    refs: { lead: lead.id, event: event.id, quote: quote.id, invoice: invoice.id },
  });
  if (!('bindingId' in bound.recorded)) throw new Error('Expected binding revision');
  const unlinked = await bridge.execute(scope, {
    action: 'unlink', idempotencyKey: 'fixture-unlink-1', expectedRevision: bound.revision,
    bindingId, expectedBindingRevision: bound.recorded.revision,
    expectedBindingDigest: bound.recorded.digest, evidenceRef: 'fixture-unlink-proof-1',
  });
  if (!('bindingId' in unlinked.recorded)) throw new Error('Expected binding revision');
  await bridge.execute(scope, {
    action: 'revert', idempotencyKey: 'fixture-revert-1', expectedRevision: unlinked.revision,
    bindingId, expectedBindingRevision: unlinked.recorded.revision,
    expectedBindingDigest: unlinked.recorded.digest, targetRevision: bound.recorded.revision,
    evidenceRef: 'fixture-revert-proof-1',
  });
}
```

## Decisiones y comprobaciones antes de integrar

1. Acordar la fuente de intake, la identidad del evento canónico y quién declara cada vínculo; no asumir que un tablero o `Recipient` es la autoridad.
2. Definir cardinalidad, sustituciones y versiones permitidas, incluyendo varias cotizaciones/facturas, y cómo se resuelven conflictos humanos de forma atribuible.
3. Elegir revisiones de origen estables, normalización/digest y verificación de evidencia; definir también retención de identificadores y procedencia.
4. Vincular autenticación/roles del servidor y registro de fuentes confiable a la autoridad de organización real; aprobar por separado la aplicación de la migración preparada. El adapter PostgreSQL ya ofrece CAS duradero y pruebas de aislamiento, carreras y reinicio.
5. Revisar separadamente cualquier import o nuevo mapping. Mantener DEMO y externo separados en consumidores y métricas; un vínculo sólo acredita una asociación explícita, nunca un resultado comercial.

Estas decisiones tienen interfaces preparadas, pero ninguna queda resuelta ni activada por este lote. La cotización aceptada, cobro, proveedor y evento realizado requieren sus propios contratos de evidencia; no se implementan aquí.

## Persistencia preparada, sin migración desplegada

`004_canonical_bridge.up.sql` crea `office_canonical_bridge.workspaces` y `audit_events`. El scope completo se conserva en columnas y debe coincidir con el hash de la clave y con el ledger. El CAS bloquea también el caso de fila ausente, exige avanzar una sola revisión y conservar todo el prefijo anterior. Un trigger añade la auditoría en la misma transacción; si falla, el workspace no cambia. Las lecturas reconstruyen el ledger y contrastan su auditoría. Actualización, borrado y truncamiento del historial se rechazan.

La migración no figura en el inicializador de Office. Las pruebas PostgreSQL la aplican expresamente sólo en esquemas `bridge_test_<uuid>` de la base local sintética. `004_canonical_bridge.down.sql` revierte un esquema vacío; con historial poblado se niega a borrarlo. La reversión operativa segura es deshabilitar el consumidor y conservar sus datos; retirar datos requiere una decisión de retención y backup/restauración revisados por separado.

## Vista de procedencia de sólo lectura

`/office/provenance` muestra dos paneles independientes. `GET /office-api/provenance` exige sesión DEMO y muestra sólo la cobertura autorizada. El provider PostgreSQL utiliza exclusivamente el namespace sintético `stateId` del servidor y el actor DEMO existente, con la fuente sintética `fixture:office`; no declara una organización ni una fuente externa. Las sesiones con restricciones de casos o funciones no leen el bridge global compartido. La falta de la migración deja los vínculos no disponibles y no crea un store alternativo.

`GET /office-api/monday/provenance` exige la sesión de propietario Monday y muestra únicamente estado local y fechas del grant. Una sesión DEMO o HTTP Basic por sí sola no la autoriza. No lee registros, renueva tokens ni llama al proveedor. La organización externa y el puente Monday permanecen sin configurar; disponibilidad de la conexión no acredita importación, vínculos ni operación comercial.

La consulta usa `readOnlyStatus()`: un intento de worker caducado se muestra sin confirmar y sin limpiar su lease ni modificar el registro guardado. El mantenimiento del estado permanece en el camino operativo existente. La regresión con el servicio real verifica cero escrituras y cero llamadas al proveedor.

La página únicamente hace GET y ofrece enlaces a las pantallas de sesión existentes. No contiene acciones de importación, vinculación, renovación o aprobación. Las referencias y revisiones visibles están acotadas a 50 por colección, con cobertura parcial explícita; desconocido nunca se presenta como cero. Ningún consumidor de métricas une los paneles.

El workflow existente de verificación admite exclusivamente la rama de recuperación y `codex/canonical-reference-bridge-20261012`, con permisos de lectura. Ejecuta PostgreSQL y navegador sintéticos y construye una imagen local; no publica ni despliega la aplicación o migraciones.
