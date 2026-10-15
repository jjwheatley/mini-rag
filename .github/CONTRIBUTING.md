# Contributing to Mini-RAG

Mini-RAG is a one-person project, maintained in spare time. Bug reports are the most useful contribution. Pull requests aren't actively sought, so please read [Sending changes](#sending-changes) before writing any code.

## Reporting bugs

Open an issue at [github.com/jjwheatley/mini-rag/issues](https://github.com/jjwheatley/mini-rag/issues). Please include:

- your Mini-RAG and Obsidian versions, and your operating system;
- the provider (Ollama or llama.cpp) and its version, plus the chat model and embedding model you use;
- what you did, what you expected, and what happened instead;
- any errors from Obsidian's developer console (`Ctrl+Shift+I`, or `Cmd+Option+I` on macOS, then the **Console** tab).

Leave out anything from your notes that you wouldn't want to be public.

Feature requests are welcome as issues too, but there's no promise they'll be built.

## Building

You need [Node.js](https://nodejs.org) 20 (the version CI uses) and npm.

```bash
git clone https://github.com/jjwheatley/mini-rag.git
cd mini-rag
npm ci
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Builds `main.js` and rebuilds it whenever a file changes |
| `npm test` | Runs the tests (Vitest) |
| `npm run verify` | Typechecks the source and tests, then runs the tests with coverage |
| `npx eslint main.ts src test` | Lints the code |
| `npm run build` | Runs `verify`, then makes a production build of `main.js` |

To try your build in Obsidian, clone the repository into a test vault's `.obsidian/plugins/mini-rag` folder, run `npm run dev`, and turn on Mini-RAG under **Settings → Community plugins**. After each rebuild, turn the plugin off and on again, or reload Obsidian, to pick up the changes. Use a test vault rather than your own.

## Sending changes

Open an issue before writing code, so we can agree the change is wanted. A pull request without one may be closed unreviewed.

If a change is agreed:

- Branch from `main`, and keep the pull request to that one change.
- Add or update tests in `test/` for any change in behaviour.
- Make sure `npx eslint main.ts src test` and `npm run verify` pass. CI runs both on every pull request.
- Match the style of the surrounding code: tabs for indentation, as set in `.editorconfig`.
- Follow Obsidian's [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines).
- Keep Mini-RAG local: it only talks to the servers the user configures, and changes that send data anywhere else won't be accepted.
- Leave version numbers, `manifest.json` and `versions.json` alone; releases are done by the maintainer.

By sending a pull request, you agree that your contribution is licensed under the project's [MIT License](../LICENSE).
