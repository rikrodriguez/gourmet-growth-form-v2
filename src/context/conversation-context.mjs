import { createHash } from 'node:crypto';

export function realTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

export function conversationDigest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Browser-independent input contract. Vault verification is an injected trust boundary. */
export function acceptConversationContext(input, { verifyVaultArtifact } = {}) {
  if (!input || input.schemaVersion !== 1 || !['google-voice', 'user-provided', 'vault'].includes(input.source)) {
    throw new Error('Formato de contexto desconocido.');
  }
  const modes = { 'google-voice': ['visible-dom', 'selection'], 'user-provided': ['manual-text'], vault: ['verified-export'] };
  if (!modes[input.source].includes(input.captureMode) || input.historyComplete !== false) {
    throw new Error('El contexto debe declarar un historial incompleto y un modo de captura válido.');
  }
  if (!realTimestamp(input.capturedAt) || input.authorization?.captureConfirmed !== true || !realTimestamp(input.authorization.confirmedAt)) {
    throw new Error('Faltan la autorización explícita de captura o sus fechas.');
  }
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 100_000) {
    throw new Error('El texto debe contener entre 1 y 100000 caracteres.');
  }
  if (!Array.isArray(input.warnings) || input.warnings.some(value => typeof value !== 'string' || value.length > 1000) || input.warnings.length > 20) {
    throw new Error('Las advertencias de contexto no son válidas.');
  }
  const context = {
    schemaVersion: 1, source: input.source, capturedAt: input.capturedAt,
    captureMode: input.captureMode, historyComplete: false,
    authorization: { captureConfirmed: true, confirmedAt: input.authorization.confirmedAt },
    text: input.text, warnings: [...input.warnings],
  };
  if (input.source === 'vault') {
    const proof = input.verification;
    if (!proof || !['fixture', 'verified-reader'].includes(proof.method) || !/^[a-f0-9]{64}$/.test(proof.artifactSha256) || !realTimestamp(proof.verifiedAt)) {
      throw new Error('VAULT_VERIFICATION_REQUIRED: falta procedencia verificable del artefacto.');
    }
    // A JSON flag never authenticates an export. The real reader must supply a verifier.
    if (typeof verifyVaultArtifact !== 'function' || verifyVaultArtifact(input) !== true) {
      throw new Error('VAULT_READER_UNAVAILABLE: el lector/verificador real no está conectado.');
    }
    context.verification = { method: proof.method, artifactSha256: proof.artifactSha256, verifiedAt: proof.verifiedAt };
    if (proof.exportMetadata !== undefined) {
      const serialized = JSON.stringify(proof.exportMetadata);
      if (!serialized || serialized.length > 16000 || !proof.exportMetadata || typeof proof.exportMetadata !== 'object' || Array.isArray(proof.exportMetadata)) {
        throw new Error('VAULT_METADATA_INVALID: metadatos de exportación no válidos.');
      }
      // Opaque verified-reader metadata: no Subject/FileName or query-path assumption.
      context.verification.exportMetadata = JSON.parse(serialized);
    }
    const fixtureWarning = 'Fixture sintético de Vault; no acredita lectura de una exportación real.';
    if (proof.method === 'fixture' && !context.warnings.includes(fixtureWarning) && context.warnings.length < 20) context.warnings.push(fixtureWarning);
  }
  return context;
}
