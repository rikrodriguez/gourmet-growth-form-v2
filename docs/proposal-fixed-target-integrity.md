# Identidad completa del expediente documental

Base inspeccionada: PR 18, `b6e602b13a5391d142d391833d23a8480d0cf5b2`.
Se reutilizan el servicio de propuestas, su store, el ledger canónico y los
fixtures existentes. No se modifica el generador PHP ni se consulta producción.

## Fallo reproducido

El expediente se guarda por ámbito, actor, lead y evento. El contrato durable
ya exige además que el target fijo incluya exactamente `proposalId`; el servicio
base no comprobaba esa identidad contra el historial guardado.

Con P1 asociada y aprobada internamente, se registra y vincula P2 en el ledger
del fixture para el mismo lead y evento. Ambas usan `sourceVersion: v1`:

- Leer P2 devolvía target P2 con snapshot P1, revisión 2. El validador real del
  cliente rechazaba la respuesta; no se ha demostrado una aprobación cruzada.
- Asociar P2 con revisión esperada 2 era aceptado: revisión 3, historial
  `[P1, P2]` y tres recibos en el mismo expediente.
- Al restaurar el vínculo P1, el replay de su comando original devolvía snapshot
  P2 y otra respuesta incompatible.

Evidencia anterior a la corrección:
`/tmp/gourmet-canonical-proposal-retarget-evidence.json` y
`/tmp/gourmet-canonical-proposal-retarget-repro.mts`.

## Comprobación añadida

El servicio exige que todos los snapshots del expediente coincidan con el triple
solicitado `leadId/eventId/proposalId`. Lo comprueba al leer y dentro de la
transacción, antes de reutilizar recibos o escribir. Una contradicción devuelve
`BINDING_MISMATCH`; no mezcla historiales ni selecciona otra propuesta por
compartir lead, evento, versión o contenido.

Se conservan la clave física, schema, documentos, digests, decisiones y recibos
anteriores. Un expediente que ya contenga targets mezclados se rechaza sin
reescribirlo. No se añade soporte implícito de propuestas paralelas ni migración.
La composición PostgreSQL conserva su comprobación previa del target completo.
Restaurar un vínculo canónico crea otro digest: la aprobación histórica continúa
guardada pero queda obsoleta y requiere otra revisión, conforme al contrato previo.

## Contrato conocido y dependencia pendiente

`lead-link-history.ts` reconoce Calculator en `text_mm1kdqqb` y Quotes en
`text_mm1mkvn`. Son referencias con procedencia; una URL de esas columnas no
determina por sí sola el UUID del lead, evento de catering, documento ni versión.
La metadata canónica `quote` tampoco constituye una `QuoteVersion` calculada.

El puerto existente `ExistingCanonicalProposalLinkOwner.readExistingLink(target)`
devuelve una selección de servidor con el triple explícito, ámbito, mapping CRM,
binding ID/revisión/digest y referencias completas `sourceSystem/boardId/itemId`.
El llamador fija independientemente el contexto esperado. El proveedor documental
verifica el target, procedencia, versión inmutable y SHA-256 de texto UTF-8 exacto;
sin contenido verificable se conserva `reference_only`.

Para conectar el generador sigue faltando el repositorio/ruta o snapshot saneado
del productor y la función que demuestra su correspondencia autorizada entre UUID
Growth, cuenta/board/item CRM, evento de catering y documento/versión. También se
requiere el contrato autorizado de lectura de los bytes de esa versión. Los
puertos actuales sólo admiten proveedor `synthetic` y modo `test`: no hay lector
del productor PHP ni transporte comercial instalados. La sesión comercial y el
permiso de aprobación deben acreditarse por sus autoridades existentes; no se
derivan de la URL, del nombre del usuario ni de una sesión de visitante.

Se mantienen cerradas las rutas normales. Payments sigue pausado; sin envíos,
cambios de accesos o datos reales, merge ni despliegue.

## Regresión y verificación

Ocho regresiones unitarias fallaron antes de corregir: lectura, asociación,
reutilización de claves, concurrencia y contradicciones históricas de cada ID
aunque el último snapshot sea válido. Ahora rechazan la operación sin alterar
snapshots, decisiones ni recibos. La regresión PostgreSQL usa un segundo pool,
reabre el payload previo y conserva exactamente ciphertext y auditoría; rechaza
el target alternativo antes de consultar al proveedor. Ambas pruebas utilizan
P1/P2 canónicas válidas con la misma versión `v1`.

```sh
npm run office:db -- start
node --import tsx --test tests/office/external-proposal.test.tsx tests/office/external-proposal-durable.test.ts tests/office/canonical-proposal-provider.test.ts
npm run typecheck
npm run build
npm run office:build
npm run test:office
npm run test:operations
npm run test:external-proposal:e2e
npm run test:external-proposal:durable:e2e
```

Resultado local: focalizadas **93/93**, Office **1197/1197** sin omisiones,
operaciones **99/99**, tipos y ambos builds correctos; navegador de propuesta
**30/30** y durable HTTP/reinicio **8/8**, en desktop y móvil. Revisión
independiente sin bloqueos de código. Logs sintéticos en
`/tmp/gourmet-document-target-{red,green,pg}.log`,
`/tmp/gourmet-document-office-full.log`, `/tmp/gourmet-document-browser.log` y
`/tmp/gourmet-document-durable-browser.log`.
