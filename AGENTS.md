# Triggerbase

## Versioning and releases

- Use Semantic Versioning. The first stable release is `1.0.0`. Publish ordinary releases as `MAJOR.MINOR.PATCH`, with a matching Git tag such as `v1.0.0`. Keep prerelease suffixes out of new public versions.
- Increment PATCH for compatible fixes, MINOR for compatible features, and MAJOR for breaking changes to rule files, the script protocol, CLI or relay API. Reset lower components to zero when incrementing MAJOR or MINOR.
- Treat `package.json` as the version source. Both host manifests, the portable plugin manifest and the packaged runner must match. Run `pnpm package:plugin` when preparing a release.
- Tag the tested commit after Linux and macOS CI pass. Publish it as a regular GitHub release with the archive, checksums and build attestation. Keep published tags and assets immutable, including historical previews. Ship corrections under a new version.
- Record known host or platform limitations in the release documentation. See the [publishing procedure](docs/development.md#publishing).

## Communication

Lead with the result. Use concise, concrete language and established project terms. For code changes, report what changed, what you verified and any material limitation.
