# Changesets

This repository releases `@stellar-sorex/sdk` with [changesets](https://github.com/changesets/changesets).

Add a changeset for every user-visible SDK change:

```bash
npm run changeset
```

Choose `patch`, `minor` or `major`, describe the change, and commit the generated
markdown file. `npm run version-packages` bumps versions and updates changelogs;
`npm run release` publishes to npm.
