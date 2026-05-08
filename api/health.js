export default function handler(_req, res) {
  return res.status(200).json({
    ok: true,
    shell: 'six_field_public',
    service: 'ASIOD Public Relay',
    private_engine_exposed: false,
    mutation_allowed: false,
    status: 'active'
  });
}
