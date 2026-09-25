export type ServerOnlyEnhancedConversionPreparation = {
  schema_version: '1.0';
  destination: 'google_ads';
  milestone: 'generate_lead';
  click_ids: {
    gclid?: string;
    gbraid?: string;
    wbraid?: string;
  };
  user_data_source: 'server_only_encrypted_lead';
};

// M3A intentionally defines only the protected server contract. No browser code
// receives plaintext or hashed lead PII, and no Google delivery worker is active.
