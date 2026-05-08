export default function handler(_req, res) {
  return res.status(200).json({
    name: 'ASIOD Public Relay',
    shell: 'six_field_public',
    service: 'B2B/A2A intake relay',
    private_engine_exposed: false,
    mutation_allowed: false,
    status: 'active'
  });
}
