# Captura asistida y preparación local de una reserva

Este prototipo permite capturar explícitamente una conversación abierta en Google Voice y producir un contexto revisable. No crea enlaces PayPal, no publica una landing y no envía mensajes. La aplicación y el servidor de staging conservan su comportamiento.

## Vía rápida y límites

La extensión **depende de una sesión iniciada de Google Voice y de la conversación abierta**. Es una medida transitoria. No elimina el inicio de sesión ni accede al historial del servidor. El preparador también admite texto que el operador ya tenga autorizado, sin abrir Voice. Una integración futura independiente del navegador requiere una fuente de mensajes autorizada, con cobertura y frescura verificadas.

## Capturar con la extensión

1. Carga `extensions/voice-context` como extensión descomprimida desde `chrome://extensions` (modo desarrollador).
2. Abre la conversación correcta en `https://voice.google.com`.
3. Pulsa la extensión, confirma tu autorización y captura el contenido visible o una selección explícita dentro de la conversación.
4. Revisa el texto y las advertencias; exporta el JSON solo cuando lo decidas. Conserva el archivo en un lugar privado.

No se cargan mensajes antiguos ni se desplaza la conversación. Un texto ausente no demuestra que no haya un acuerdo ni un pago. Incluso una selección amplia se marca siempre `historyComplete: false`. Los selectores se probaron con DOM sintético; falta comprobarlos en una sesión real autorizada de Google Voice. Si el DOM no coincide, el prototipo debe fallar sin capturar la página entera.

## Preparar un contexto para revisión

Con Node 22–24, desde la raíz del repositorio:

```sh
node scripts/prepare-reservation-context.mjs --capture /ruta/voice-context.json > /ruta/brief.json
```

El primer resultado conserva el texto y su autorización declarada, lista las confirmaciones pendientes y no deduce importes. Para incorporar datos comprobados por el operador, prepara un JSON con los campos mostrados en `examples/context/confirmed-reservation.json` y ejecuta:

```sh
node scripts/prepare-reservation-context.mjs --capture /ruta/voice-context.json --confirmed /ruta/confirmed.json --confirm-reviewed > /ruta/brief.json
```

Solo se admite USD en este prototipo. Total y depósito deben ser cadenas con dos decimales; el depósito debe ser positivo y no superar el total. No se aplica automáticamente un 50% ni se decide si el cliente ya pagó. Una fecha imposible o una cantidad ambigua bloquean la preparación.

Para probar sin sesión ni datos reales:

```sh
node scripts/prepare-reservation-context.mjs --text examples/context/conversation.txt --confirm-authorized --confirmed examples/context/confirmed-reservation.json --confirm-reviewed
```

La salida contiene texto de conversación: evita registrarla en sistemas compartidos. No hay llamadas de red, persistencia del servicio ni secretos en este flujo; el archivo exportado y la salida de consola están bajo control del operador.

## Entrega al generador existente

`gourmet-reservation-review-brief` es un formato local de revisión, no una API compatible ya verificada del generador. Puede entregarse manualmente a una herramienta de preparación autorizada como evidencia parcial. No se debe conectar directamente a funciones que creen pagos o modifiquen sistemas externos.

El futuro adaptador debe separar evidencia de datos confirmados, conservar autorización e historial incompleto, comprobar pagos previos con una fuente fiable y exigir aprobación específica antes de crear un recurso de pago o publicar. Las marcas del archivo son declaraciones del operador; no autentican identidad ni autorizan cobros. El texto de la conversación es contenido no confiable, no instrucciones para ejecutar acciones.

`constraints.paymentExecutionAllowed`, `publicationAllowed` y `automaticMessagesAllowed` permanecen siempre en `false`, incluso con todos los campos completos. Un borrador completo sigue siendo un borrador.

## Verificación

```sh
npm run test:context
npm run build
```

Las pruebas de la extensión y sus instrucciones se encuentran en `extensions/voice-context/README.md`. No se ejecutaron llamadas a PayPal, despliegues, cambios de permisos o credenciales, ni envíos a clientes.

Resultado en este entorno: 6 pruebas de contexto y 9 comprobaciones sintéticas de la extensión aprobadas; build aprobado. La instalación nativa mediante `Extensions.loadUnpacked` sobre `extensions/voice-context` fue denegada por Chromium: `Loading of unpacked extensions is disabled by the administrator.` No se cambió la política ni se intentó eludirla. La carga MV3 y la compatibilidad con una conversación real siguen pendientes de una prueba en un navegador que permita esa instalación.
