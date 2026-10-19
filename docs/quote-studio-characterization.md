# Caracterización de los límites de Quote Studio

Base revisada: PR 18, `c02761162db41bd97d56df580c42130368d92aae`.
No había caracterización de Quote Studio en el código, tests o documentación de
este candidato. Sí existían controles genéricos del proveedor, identidad, versión,
procedencia y tamaño; esta tarea conserva esos controles y añade vectores de prueba.

## Fuente y alcance de la evidencia

La solicitud cita el thread `01a14a22-9fcb-70de-8c3b-9b17a516d0db` y reporta un
load `{ok,id,revision,state}`, `projectId` constante de plantilla y un payload
observado de 579815 bytes. El thread no se pudo recuperar en este cloud:
Personal Context respondió «Personal context is unavailable for this
conversation». Tampoco se encontró el productor Quote Studio en este checkout
o su historial disponible. Los hechos anteriores se atribuyen al resumen aportado
en la tarea; no se afirma una nueva inspección del PHP, endpoint o respuesta real.

Los fixtures son enteramente sintéticos. Sólo representan el sobre reportado,
una plantilla compartida y relleno identificado como sintético para ejercitar
tamaños. No copian contenido, IDs o URLs reales ni declaran el esquema completo
del editor. Los 579815 bytes son un vector del tamaño reportado, no prueba del
tamaño de un documento exportado ni de que el estado real tenga estos campos.

## Contratos comprobados en este candidato

- `snapshotProposalDocument` / `verifyProposalDocument` exigen el contrato
  documental existente: triple explícito, ámbito test, proveedor synthetic,
  versión opaca, contenido/evidencia y procedencia autorizada. El sobre de carga
  del editor es otro formato; `ok: true` no constituye un documento ni aprobación.
- `projectId` compartido no demuestra identidad del documento, relación CRM o
  pertenencia a lead/evento. Esos IDs siguen viniendo del contexto autorizado del
  servidor. No se añade traducción desde la plantilla o desde `load.id`.
- La revisión del productor no se equipara automáticamente a `sourceVersion`,
  revisión del binding canónico o revisión del registro. El vínculo documental
  existente exige ID, versión y digest exactos; la aprobación interna es separada.
- El proveedor limita `content` a **262144 bytes UTF-8**, inclusive. El validador
  del cliente exige el mismo límite. No se mide por número de caracteres ni se
  permite truncar, dividir o normalizar contenido para pasar ese límite.
- El repositorio durable limita el JSON completo del agregado a 524288 bytes
  antes de cifrarlo. Aumentarlo no resolvería el límite documental, que se
  comprueba antes de escribir.

Las pruebas pasan el sobre crudo o un intento explícitamente sintético de usar
JSON de editor como `content` por las fronteras existentes. El control de JSON
sintético de 262144 bytes se acepta como texto bajo el contrato documental
explícito, quedando pendiente de revisión interna. Los rechazos se deben al sobre
incompatible o al exceso de bytes. No permiten concluir que un PDF/HTML/texto
exportado tenga ese tamaño: falta el contrato de exportación. Tampoco hay un
detector semántico de formatos del editor ni se añade uno aquí; no se construye
conversor, adaptador o proveedor de Quote Studio.

## Verificación y condición pendiente

```sh
npm run office:db -- start
node --import tsx --test tests/office/quote-studio-characterization.test.ts
npm run typecheck
npm run test:office
```

La suite existente incluye automáticamente el archivo nuevo. Se reutilizan sus
fixtures, puertos y autorización transaccional; se comprueba que las entradas
rechazadas no cambian registro, recibos, decisiones, auditoría ni ledger canónico.
Un control documental sintético válido conserva su comportamiento normal.

Resultado local: caracterización **4/4**, regresiones conjuntas de proveedor,
adaptador canónico y respuesta **81/81**, tipos correctos y Office **1201/1201**
sin omisiones. La revisión independiente no encontró bloqueos. Evidencia:
`/tmp/gourmet-quote-studio-characterization.log`,
`/tmp/gourmet-quote-studio-boundaries.log` y
`/tmp/gourmet-quote-studio-office-full.log`. No se modificó código productivo,
límites, proveedor, esquema, dependencias ni configuración de CI.

Para conectar el productor falta una fuente cloud o snapshot saneado del código,
su correspondencia autorizada entre ID/revisión de Quote Studio y el triple
lead/evento/propuesta, referencias CRM, versión inmutable y bytes documentales
exportados. Una plantilla o respuesta de carga no sustituye esa evidencia. Los
puertos actuales continúan TEST_ONLY; no se relajan límites ni se crea un vínculo
CRM real. Sin cambios PHP, transporte, rutas normales, credenciales, Payments,
mensajería, merge ni despliegue.
