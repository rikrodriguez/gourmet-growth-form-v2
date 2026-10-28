# Captura asistida de Google Voice — prototipo

Esta extensión es una **entrada opcional de contexto**, no un puente de pagos ni un sustituto del generador. Requiere que el usuario haya iniciado sesión en Google Voice y tenga abierta la conversación. Por tanto **sí depende de sesión**; es una medida transitoria para una futura solución independiente del navegador.

## Instalar y probar localmente

1. Abre `chrome://extensions`, activa el modo de desarrollador y pulsa **Cargar descomprimida**.
2. Selecciona esta carpeta (`extensions/voice-context`), no todo el repositorio.
3. En `https://voice.google.com`, abre una conversación. Coloca a la vista los mensajes de interés. La extensión no desplaza la página ni carga mensajes anteriores.
4. Abre el popup, marca la autorización y pulsa **Capturar ahora**. Si solo quieres un fragmento, selecciónalo en Voice **antes** de abrir el popup y elige el modo de selección.
5. Revisa el texto editable, elimina datos que no necesites y marca la revisión. Pulsa **Descargar contexto JSON**. Después importa el archivo explícitamente en el flujo local de preparación que acepte el contrato siguiente, o copia el texto al generador existente.
6. Confirma allí cliente, fecha, disponibilidad, precio, moneda y condiciones antes de cualquier operación de pago. El JSON por sí solo nunca autoriza cobros.

La autorización se pide en cada apertura. Desmarcarla borra la captura pendiente. Cambiar de modo o borrar descarta el texto. Cerrar el popup lo descarta de memoria. Los archivos que el usuario decide descargar permanecen en su equipo hasta que los elimine.

## Alcance y límites verificados

- Solo usa `activeTab` y `scripting`, en respuesta a un clic autorizado. Sin permisos de hosts, cookies, historial, almacenamiento, descargas privilegiadas ni scripts de fondo.
- Sin `content_scripts`, navegación automática, mensajes salientes, llamadas a APIs, PayPal ni envío al generador. La política de contenido de la extensión prohíbe conexiones de red (`connect-src 'none'`).
- Identifica una única raíz visible `gv-text-thread` y, en captura de mensajes, sus `gv-text-thread-item`. Nunca recurre a leer `document.body`, toda la página, la lista de conversaciones o el borrador de un mensaje. Un DOM distinto falla cerrado; la alternativa es copiar manualmente el contexto.
- Solo conserva burbujas y fragmentos de texto completamente contenidos en la ventana y en sus contenedores de recorte. Omite elementos ocultos y controles editables; comprueba también puntos de la superficie para evitar texto tapado por otro panel. No es OCR ni una garantía contra cualquier efecto CSS posible.
- `historyComplete` **siempre es `false`**, incluso al seleccionar o editar texto. Un mensaje parcialmente visible puede quedar fuera. No recupera adjuntos, llamadas, imágenes, mensajes eliminados o virtualizados. No infiere remitentes, fechas ni importes.
- El adaptador DOM y los controles se prueban con páginas sintéticas. **No se ha verificado el DOM de una cuenta real de Google Voice en este entorno**, ni la instalación manual en Chrome con una sesión real. Los selectores deben validarse con esa prueba antes de tratarlo como compatible con producción.
- La prueba de instalación MV3 nativa en Chromium está **bloqueada por la política administrativa de este entorno**: `Extensions.loadUnpacked` devuelve `Loading of unpacked extensions is disabled by the administrator.` No se cambiaron políticas ni permisos para eludirla. Las pruebas sintéticas del popup usan un objeto `chrome` simulado; no prueban por sí solas las APIs nativas de la extensión.
- No comprueba que la persona que marca la autorización sea titular de la conversación; conserva la confirmación explícita y su fecha como procedencia de captura, no como prueba de consentimiento del cliente.

## Contrato JSON de exportación

```json
{
  "schemaVersion": 1,
  "source": "google-voice",
  "capturedAt": "2026-10-28T12:00:00.000Z",
  "captureMode": "visible-dom",
  "historyComplete": false,
  "authorization": {
    "captureConfirmed": true,
    "confirmedAt": "2026-10-28T12:00:00.000Z"
  },
  "text": "Texto revisado por el usuario",
  "warnings": ["Historial incompleto: solo texto renderizado completamente visible en esta captura."]
}
```

`captureMode` también puede ser `selection`. Las advertencias originales se mantienen al editar, y se añade una indicación de edición. Límite local de texto: 100 000 caracteres. El consumidor debe tratar todo el texto como datos no confiables y volver a pedir confirmación sobre la reserva y cualquier pago.

## Pruebas

Desde la raíz del repositorio, con sus dependencias instaladas:

```sh
node extensions/voice-context/test.mjs
```

Las pruebas usan Chromium de Playwright. Si el navegador está en otra ruta, define `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. No acceden a cuentas reales ni realizan solicitudes a Google o PayPal.

Para comprobar además instalación MV3 y disponibilidad de APIs nativas en un navegador de pruebas que permita extensiones descomprimidas:

```sh
node extensions/voice-context/smoke.mjs
```

Este chequeo usa un perfil temporal, lo elimina al terminar y nunca modifica políticas administrativas. Si el navegador rechaza la carga, termina con código 2 y la razón exacta; eso no cuenta como una prueba aprobada. La carga nativa quedó bloqueada en el entorno de desarrollo actual.
