# Contexto revisado → generador local de reserva

La interfaz principal es independiente del navegador. Acepta un contexto autorizado, extrae candidatos con citas exactas, exige revisión del acuerdo y prepara una vista local con el adaptador puro del generador existente. La extensión es una entrada temporal; requiere sesión de Google Voice abierta.

Todo el camino implementado es `fixture-only`: sin proveedor de pagos, cobros, mensajes ni publicación. La salida HTML elimina enlaces y recursos externos, añade una marca de demostración y una política de contenido restrictiva. El payload PayPal es un archivo de revisión; no se envía.

## Inspeccionar sin navegador

Con Node 22–24 y desde la raíz:

```sh
npm run context:fixture -- --vault-fixture examples/context/vault-fixture.json --monday examples/context/monday-fixture.json
```

El fixture es ficticio y está marcado explícitamente. Muestra una propuesta inicial de USD 1000/250, una posterior de USD 1200/300, una aceptación posterior y un snapshot discrepante de Monday. No representa una reserva ni un pago.

El resultado contiene candidatos por campo, citas, offsets UTF-16, ausencias y conflictos. `latestInCapture` indica posición en este extracto; nunca demuestra el último acuerdo de todo el historial. Una actualización posterior pendiente o no compatible invalida el valor anterior. No se transforma ausencia en un depósito del 50% ni se infiere moneda a partir de `$`.

El extractor es conservador: solo entiende las etiquetas documentadas en `extensions/voice-context/README.md`. El texto natural no compatible requiere revisión; no se debe reescribir una conversación para hacer pasar una prueba. Las citas son datos, no instrucciones ejecutables.

## Revisar antes de generar

`examples/context/reviewed-evidence.json` ilustra el contrato de revisión. Cada campo requiere un candidato exacto y confirmación explícita, más una cita de aceptación posterior a las propuestas visibles. El hash liga la revisión al texto exacto: editarlo invalida la revisión. Conflictos de conversación o Monday exigen una resolución explícita. Un estado de pago previo desconocido o pagado bloquea incluso el fixture.

La revisión humana interpreta el acuerdo; el programa no demuestra por semántica que una frase sea aceptación ni que el extracto incluya el último mensaje. Siempre conserva `historyComplete:false`. No hay aprobación comercial implícita.

Con el adaptador puro externo instalado y revisado localmente:

```sh
npm run context:fixture -- --vault-fixture examples/context/vault-fixture.json --review examples/context/reviewed-evidence.json --monday examples/context/monday-fixture.json --adapter /ruta/local/fixture-adapter.php --php /ruta/local/php --out /ruta/nueva/demo-reserva
```

Crea exclusivamente `preview.html`, `paypal-request.fixture.json` y `review-report.json` en un directorio nuevo. Los únicos destinos admitidos para el fixture terminan en `.invalid`; la vista elimina sus enlaces. Total y depósito provienen de evidencia revisada, con USD explícito y centavos exactos. No se aplica porcentaje por defecto.

El adaptador externo reutiliza la plantilla y el builder de solicitudes del generador existente mediante funciones puras compartidas. El componente externo y su fuente no se incluyen en este repositorio. Si no está instalado, la generación falla; no se presenta un renderer de prueba como integración real. `tests/fixtures/fake-generator-process.mjs` es solo una prueba del protocolo.

## Contrato independiente de la fuente

`src/context/conversation-context.mjs` exporta `acceptConversationContext()`. Se conserva compatibilidad con los JSON de Google Voice y texto autorizado. Para Vault se admite `source:'vault'`, `captureMode:'verified-export'` y `verification` con método, hash del artefacto y fecha. **Una bandera JSON no verifica una exportación**: el caller debe inyectar un `verifyVaultArtifact` síncrono que realmente autentique el artefacto.

El lector real de Vault está pendiente. `--context vault-real.json` falla con `VAULT_READER_UNAVAILABLE` mientras no exista ese verificador. `--vault-fixture` solo admite el fixture marcado y comprueba el hash del texto sintético; no es una prueba de lectura de exportaciones reales.

Los metadatos de exportación verificados se conservan de forma opaca y limitada. No se impone `FileName = Subject`; pueden describir identidad por `Message-ID` y la ruta `Batch/CustomBatchInfo/Query` con `UserQuery`, `TimeZone` y `Custodians`. Esto prueba conservación del contrato, no un parser XML/MIME ni compatibilidad con exportaciones nuevas.

## Monday

`compareMonday()` recibe un snapshot explícitamente asociado al lead/evento y conserva ambos valores cuando difieren. No sobrescribe Voice ni elige automáticamente la fuente más reciente. Sin snapshot informa `unavailable`, sin inventar verificación. El CLI no consulta ni modifica servicios: los fixtures prueban el contraste; una lectura real requiere identidad autorizada y acceso al registro concreto.

## Entrada temporal de Google Voice

Carga `extensions/voice-context` como extensión descomprimida. Autoriza una captura, revisa texto y sugerencias, y descarga el JSON explícitamente. No desplaza la conversación ni carga mensajes antiguos. La instalación nativa quedó denegada por política administrativa del navegador de pruebas; DOM y UI solo se probaron sintéticamente. Sigue pendiente una sesión real autorizada.

Se puede inspeccionar un archivo capturado sin usar el navegador:

```sh
npm run context:fixture -- --context /ruta/voice-context.json
```

El preparador anterior `npm run context:prepare` conserva una entrada manual transitoria. Sus valores manuales no saltan la validación de evidencia del nuevo generador.

## Pruebas

```sh
npm run test:prototype
npm run build
npm run test:generator:external -- --php /ruta/local/php --adapter /ruta/local/fixture-adapter.php
```

La última orden es una integración externa explícita, separada de los mocks públicos; si falta el componente, falla y no cuenta como prueba aprobada. No se han verificado credenciales, cuenta receptora, recursos PayPal reales, Vault real ni despliegues. Las autorizaciones del archivo son declaraciones del operador y nunca credenciales o consentimiento de cobro.
