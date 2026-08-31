/**
 * Final outputs produced by the retired task-reuse and Lite overlays on the
 * Trellis 0.6.16 baseline.
 *
 * Clean 0.6.16 templates are recognized through the project's own template
 * receipt. This small list exists only for overlay writes that did not refresh
 * that receipt; older Trellis baselines are intentionally absent.
 */
export const TRELLIS_0616_OVERLAY_HASHES: Readonly<
  Record<string, readonly string[]>
> = {
  ".agents/skills/trellis-brainstorm/SKILL.md": [
    "040e9a60859e74b1ad0ff1c35fd6624eaeb3bd5dab3de692f6dbfc0fe41db1e4",
    "0f2cf577e1141aec6fb66fe47893b3be15118e081beb9ee5e8c11b485fab0114",
  ],
  ".agents/skills/trellis-check/SKILL.md": [
    "1edb6f13e28f22e4aa48e2d746e2ebe8f03f2d48b7373d8b4f4adc6a88de5a5e",
  ],
  ".agents/skills/trellis-continue/SKILL.md": [
    "482c4b70a7e3ddfe62b46d301046104b4d9719486bd463aa5b242e9212d51292",
    "e84522165126bd6f7a2a1a078615489571bd19afb0f7ca977f4acb7a0bbe82a6",
  ],
  ".agents/skills/trellis-meta/references/customize-local/change-task-lifecycle.md":
    [
      "a96f3924bda2d221b14468b8c04d81c7ee38b259ca5a072ddb1e32652f0e2a00",
    ],
  ".agents/skills/trellis-meta/references/local-architecture/task-system.md": [
    "f40354590cf3a37d2f212a309df0ff3cce9c7b40c57db98468a8df7dbc0e8b32",
  ],
  ".agents/skills/trellis-session-insight/SKILL.md": [
    "26231d89563155b4a549e27dc94ab9f92b4b29e14a2f17e1ae3ff0f97c7cb753",
  ],
  ".agents/skills/trellis-session-insight/references/cli-quick-reference.md": [
    "eff1b548f47b7779f401a78c76386730731f8dbceb5e66f33695d4d678e21692",
  ],
  ".agents/skills/trellis-start/SKILL.md": [
    "c2cf7022e1c00564bd3c1dd2fe1633d662f51c2ce240d10388da64de219459dc",
    "d23e0fa3970da633986c83e0e2ac244e3cb7331a1bd36a1c57a798e89693e42b",
  ],
  ".codex/agents/trellis-check.toml": [
    "08847d928889cc63c6510979b10354b1dfe4b310aba141f20ba05d67d9765e6a",
  ],
  ".codex/hooks/session-start.py": [
    "de5dbc8cda5a0197edbdffe1ce01b2ae9a0c3ee9a8c93a43f578db1c5e3be25a",
  ],
  ".omp/agents/trellis-check.md": [
    "4310d68c07ecdb8cf81602faced44e57907c9a036edd90925c63837482eea635",
  ],
  ".omp/commands/trellis-continue.md": [
    "03de3c9f30fd23d98e50235ee64443a2acc293317b3b9e065fa08c73c17d5bfc",
    "e27f58a12af8a24a7e2ac89e4055f47e01aead2f9f524161b5e6764b45358a3a",
  ],
  ".omp/extensions/trellis/index.ts": [
    "1412874fbc17bf97c7628f03fd7e138a4c48d475bfb7bf2c3407ef28fae722c8",
  ],
  ".omp/skills/trellis-brainstorm/SKILL.md": [
    "040e9a60859e74b1ad0ff1c35fd6624eaeb3bd5dab3de692f6dbfc0fe41db1e4",
    "6352f1590d5ea1705350ae8c42cf04e4fe9fcb51c5f8970c6d0f45b4f4c1893b",
  ],
  ".omp/skills/trellis-check/SKILL.md": [
    "1edb6f13e28f22e4aa48e2d746e2ebe8f03f2d48b7373d8b4f4adc6a88de5a5e",
  ],
  ".omp/skills/trellis-meta/references/customize-local/change-task-lifecycle.md":
    [
      "a96f3924bda2d221b14468b8c04d81c7ee38b259ca5a072ddb1e32652f0e2a00",
    ],
  ".omp/skills/trellis-meta/references/local-architecture/task-system.md": [
    "f40354590cf3a37d2f212a309df0ff3cce9c7b40c57db98468a8df7dbc0e8b32",
  ],
  ".omp/skills/trellis-session-insight/SKILL.md": [
    "26231d89563155b4a549e27dc94ab9f92b4b29e14a2f17e1ae3ff0f97c7cb753",
  ],
  ".omp/skills/trellis-session-insight/references/cli-quick-reference.md": [
    "eff1b548f47b7779f401a78c76386730731f8dbceb5e66f33695d4d678e21692",
  ],
  ".trellis/scripts/common/active_task.py": [
    "f9fa7f7a8cb5286c4ccf204cc7368c2fbf81eb34466546ddc6f9e3b5934d7e4d",
  ],
  ".trellis/scripts/common/task_store.py": [
    "8216d92df4e60ac66fdd11b9051571c0c55d72503b7406a59b39f8c93e86a684",
  ],
  ".trellis/scripts/task.py": [
    "e44229e9cabb002b1618ddab1975a316e52244417d0bd1cfad213917d8ffb92c",
  ],
  ".trellis/workflow.md": [
    "3fcd0c12a4a14551c5c5b8f1ce2c970bd1f3f4446a7f34a6adeee884ecb5caf1",
    "e26cad53f5eab3e34586779c26a3c70747151f0f3af429e072f40a4cf826ac39",
  ],
} as const;
