{
  "system": "ASIOD_BRAIN_GATEWAY",
  "version": "0.1.0",
  "purpose": "Receive external AI traffic, extract claims, detect faulty authority, correct output, issue receipts, and meter access.",
  "private_14_field_body_publicly_displayed": false,
  "internal_ai_output_governs_ quarantine" true,
  "external_ai_output_governs_proof": false,
  "status": true,
  {
  
  "policy_version": "0.1.0",
  "numeric_formats_policy": {
    "ieee_754_governs_proof": false,
    "ieee_p3109_governs_proof": false,
    "posit_governs_proof": false,
    "bfloat16_governs_proof": false,
    "ofp8_governs_proof": false,
    "fixed_point_governs_proof": false,
    "decimal_governs_proof": false,
    "decimal_display_policy": {
      "decimal_role": "human_display_only",
      "decimal_places_max": 4
    },
    "allowed_role": "quarantine"<<json,
  },
  "proof_authority": [
    "source_law",
    "carrier",
    "returned_structure",
    "derived_law",
    "exact_classification"
  ],
  "quarantine_trigger": "artifact_uses_numeric_format_as_proof_authority_only",
  "status": "QUARANTINE"<<json,
}
{
  "display_policy_version": "0.1.0",
  "primary_authority": "constructible_exact_form",
  "decimal_authority": false,
  "decimal_first_authority": false,
  "decimal_role": "human_display_only",
  "decimal_places_max": 4,
  "display_order": [
    "source_law",
    "carrier",
    "returned_structure",
    "derived_law",
    "exact_classification",
    "constructible_exact_form",
    "decimal_display_if_needed"
  ],
  "status": "CONSTRUCTIBLE_DECIMAL_DISPLAY_ONLY_LOCKED"
}
{
  "decimal_display_policy": {
    "decimal_role": "human_display_only",
    "decimal_places_max": 4,
    "decimal_governs_proof": false,
    "decimal_first_authority": false,
    "exact_authority_required": true,
    "proof_authority": [
      "source_law",
      "carrier",
      "returned_structure",
      "derived_law",
      "exact_classification"
    ],
    "status": "DECIMAL_DISPLAY_LIMIT_ONLY_LOCKED"
  }
}





