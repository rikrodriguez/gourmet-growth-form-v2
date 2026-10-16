# Sesión del host e importación documental: puertos integrados, TEST_ONLY

Base verificada: PR8 `f39f35edc6f2e27f1f9c934c3e23ce79a7038e5b`. Este corte prepara los puntos reales de adaptación dentro del servicio y HTTP existentes. No crea otro harness, login, editor, panel, directorio de IDs ni esquema de autorización.

## Identidad que existe en este repositorio

- [`session.ts`](../src/office/backend/session.ts): `DevelopmentSessions` conserva sesiones DEMO en memoria, actor DEMO y roles viewer/operator. `storage.durable` describe los datos Office, no la identidad. [`http.ts`](../src/office/backend/http.ts) publica esa sesión bajo `/office-api/session`, cookie `gourmet_office_demo` con Path=/office-api.
- [`staging.ts`](../src/office/backend/staging.ts): Basic Auth y peer/origen permitidos protegen staging; no proporcionan principal tenant/workspace/actor ni una sesión durable de operador.
- [`monday-owner.ts`](../src/office/backend/monday-owner.ts): su comentario de contrato declara la sesión bootstrap independiente de Basic/DEMO y que authenticated/status no prueba la identidad de una persona; reiniciar cierra esa sesión en memoria. No se modifica ni se consulta el proveedor.
- [`quote-access-postgres.ts`](../src/office/backend/quote-access-postgres.ts) y migración 006: existen comprobaciones durables de proof, sesión, usuario, membresía, asignación, grants, versiones y caducidad. Sólo admiten modo test. Los servidores normales no aplican esa migración ni conectan un lector de sesión comercial a estas rutas.

Por tanto, **no se encontró un dueño de sesión comercial durable conectado al host**. No se adivina una cookie, no se reutiliza Basic como identidad y no se convierte DEMO mediante una bandera.

## Puerto del dueño de sesión y vínculo de IDs

[`proposal-host-session.ts`](../src/office/backend/proposal-host-session.ts) define `ExistingProposalSessionOwner<Request>.readExistingSession(request)` y `createExistingProposalSessionResolver`. El request es opaco: el adaptador no interpreta headers, cuerpo o parámetros. El dueño existente debe devolver únicamente:

```
{
  proof: { sessionToken, csrfToken }, // prueba ya existente, nunca emitida aquí
  scope: { organizationId, workspaceId, mode: 'test' },
  actorId,
  target: { leadId, eventId, proposalId }, // caso ya vinculado por el servidor
  expiresAtMs                           // caducidad de esa sesión, no renovada aquí
}
```

El target esperado se suministra en la composición del servidor. Se exigen coincidencia exacta de sus tres IDs, datos planos sin campos adicionales/accesores y valores separados de las referencias del dueño. Faltar el dueño produce `HOST_SESSION_UNCONFIGURED`; faltar sesión válida, una proyección DEMO/Basic/bootstrap, modo comercial, IDs contradictorios o caducidad producen rechazo. Fallos del lector se reducen a `HOST_SESSION_UNAVAILABLE`, sin exponer errores/cookies. No hay fallback.

El resultado es compatible con el `resolveExistingSession` HTTP actual e incorpora **restricciones**, no permisos. El mismo `PostgresQuoteAccessRepository.run` corrobora actor, organización, workspace y evento contra SQL, mantiene los locks existentes y usa el mínimo de caducidades host/SQL/membresía/grant hasta COMMIT. Rechaza status sin evento para un proof ligado a caso. La restricción host forma parte de la revisión HMAC; cambiarla invalida presentaciones anteriores. No se emiten sesiones, crean usuarios o modifican roles/grants. Los consumidores test existentes sin binding conservan su comportamiento explícito; no son una alternativa automática al dueño ausente.

El servicio durable compara también lead/evento/propuesta ligados a la sesión con su target fijo. Luego recupera el expediente cifrado por actor/ámbito/lead/evento, comprueba su target completo y su mapping durable y corrobora las versiones y refs contra el ledger canónico actual, dentro de la misma transacción. No deriva IDs por nombre o URL ni crea una tabla/directorio paralelo.

## Contrato e importación del proveedor documental

[`external-proposal-provider.ts`](../src/office/backend/external-proposal-provider.ts) extrae el tipo documental existente y el puerto `ExternalProposalDocumentProvider.read(target): Promise<unknown>`. `readProposalDocument` valida y separa el resultado antes de usarlo. El contrato actual admite exclusivamente proveedor synthetic, ámbito test y texto UTF-8 exacto de hasta 262.144 bytes, o `content: null` para referencia sola. Exige los tres IDs, ámbito, versión inmutable, evidenceRef y procedencia histórica quote que coincida con el caso. Rechaza otros proveedores, scopes, IDs, campos/hash suministrados por el proveedor, accesores, texto vacío, tamaño excesivo y Unicode que no conserve sus bytes UTF-8. Calcula SHA-256 del contenido, sin normalizar Unicode o saltos de línea.

El servicio existente de propuestas usa este contrato para revisar evidencia; el repositorio lo usa al validar documentos persistidos. Los imports antiguos conservan su firma y se canalizan por el mismo contrato. No se cambia el formato almacenado ni la serialización/reviewKey de documentos válidos.

`createDurableTestProposalService(...).publishFromProvider(proof, provider)` es el siguiente bloque independiente terminado del expediente: importación explícita de servidor dentro de la autorización/transacción vigente. Primero autoriza escritura; después invoca el puerto, corrobora IDs/procedencia y persiste con el CAS/historial cifrado existentes. Faltar proveedor produce `PROVIDER_REQUIRED`. La repetición exacta de una versión no crea otra revisión; cambiar su contenido bajo la misma versión se rechaza. Una versión nueva invalida la aprobación documental vigente. La caducidad host durante I/O revierte también la importación. `reference_only` no adquiere hash ni aprobación documental. La aprobación sigue siendo interna, sin envío ni aceptación del cliente.

No se instala una implementación remota: este puerto no contiene fetch, apertura de URLs, preview, descubrimiento, reintentos ni credenciales. No se añade una ruta HTTP de importación. Los cuatro endpoints TEST_ONLY actuales conservan sus controles de origen, CSRF y revisión. Los servidores/entrypoint normales, las rutas comerciales y Payments permanecen sin cambios.

## Conexión comprobada y pruebas

El supervisor/API de PR7/8 se reutiliza. Su dueño sintético entrega la prueba, actor, scope, target y caducidad de los mismos fixtures SQL preexistentes. Acceso, historial, propuesta y lectura de brief usan el resolver; el control de nueva versión usa `publishFromProvider`. Los navegadores existentes de Dashboard y durable recorren así estos puertos, con los mismos paneles y reinicio de PID/Pool. No se añade una aplicación o servidor de demostración nuevo.

```
npm run office:db -- start
node --import tsx --test tests/office/proposal-host-session.test.ts tests/office/external-proposal-provider.test.ts
npm run test:external-proposal:dashboard:e2e
npm run test:external-proposal:durable:e2e
```

Las 16 pruebas nuevas cubren ausencia/retirada de dueño; DEMO/Basic/bootstrap; discrepancias de principal y caso; proof inexistente sin crear filas; permisos SQL retirados o de lectura; restricción host en HMAC y rollback al vencer; hash conocido y UTF-8 exacto; datos malformados; importación, recuperación/replay, versión conflictiva, referencia sola y ausencia de I/O/rutas normales. Las regresiones previas conservan las comprobaciones de brief, destinatario, vínculo, aislamiento, idempotencia y hash/reviewKey.

## Dependencia exacta restante

1. **Dueño real de la sesión:** módulo/servicio responsable y su función de lectura server-side, prueba existente compatible con la autoridad SQL, principal y mapping de caso autorizados, caducidad y semántica de logout/revocación/versiones. La retirada debe corresponder a la autoridad SQL ya bloqueada/versionada, no a una nueva bandera en este adaptador. Este repositorio no aporta ese lector comercial. Es insuficiente entregar sólo una cookie, username Basic, ID de actor o `durableIdentity: true`.
2. **Proveedor autorizado:** identificador/cuenta, acceso de lectura ya autorizado, API de documento y versión inmutable, procedencia y formato exacto. Este contrato sólo verifica texto UTF-8 synthetic; no se presupone el formato de Hostinger ni se añade soporte PDF/HTML binario sin evidencia. Falta implementar ese transporte contra su contrato real; una URL histórica sola seguirá siendo reference_only.
3. **Activación comercial fuera de este corte:** revisión aprobada de schema/vault/lifecycle y de los gates test-only/origen/host. La migración 006 y el repositorio aún rechazan modo comercial. Ninguna variable de entorno conecta o promueve este recorrido por sí sola.

Con esos datos se pueden suministrar los dos puertos al servicio/HTTP existente; no se requiere inventar otra pantalla o autenticación. Hasta entonces la entrada normal sigue cerrada. Sin acceso a clientes/proveedores reales, nuevas credenciales/accesos, cambios de permisos, merge ni despliegue.
