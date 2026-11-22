# Triggerbase

## Versioning and releases

- Publish regular releases as `MAJOR.MINOR.PATCH` with matching `v` tags. Choose the number by the scope of the product change.
- **PATCH** for bugs and gaps in an existing capability. Accepting Circleback’s signing key so its supported webhook can connect directly is a patch, even though the fix adds a CLI command.
- **MINOR** only for a conceptually new product capability. Giving agent rules the option to start a chat in a separate Git worktree qualified for `1.1.0`.
- **MAJOR** only for a full rebuild of the product. Reset the lower components when incrementing a major or minor number.
- Treat `package.json` as the version source. Both host manifests, the portable plugin manifest and the packaged runner must match. Run `pnpm package:plugin` when preparing a release.
- When a rule format changes, add one ordered step in `src/rule-migrations.ts`. Run migrations during plugin setup. Write the new schema to rule files and queued snapshots before starting the new runner. The runner accepts only the current schema. Test upgrades from earlier formats and update the examples and rule authoring instructions.
- Tag the tested commit after Linux and macOS CI pass. Publish it as a regular GitHub release with the archive, checksums and build attestation. Keep published tags and assets immutable, including historical previews. Ship corrections under a new version.
- Record known host or platform limitations in the release documentation. See the [publishing procedure](docs/development.md#publishing).

## Communication

Lead with the result. Use concise, concrete language and established project terms. For code changes, report what changed, what you verified and any material limitation.
