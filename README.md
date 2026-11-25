# Alkuin

Alkuin is a markdown editor for Mac with a margin for suggestions. You write in
ordinary markdown files on your own disk. A suggestion from a collaborator, or
from Alkuin's writing help, appears beside the text, and nothing in your file
changes until you accept it.

Download the app at [alkuin.app](https://alkuin.app).

This repository is the Mac app. It is free software under the
[GNU General Public License, version 3](./LICENSE).

## Based on Writer

Alkuin is a modified version of
[Writer](https://github.com/joelbqz/writer-computer), which is also under the
GNU General Public License, version 3. The Alkuin changes were made in 2026.
Writer's licence is kept as it was, in `LICENSE`. The editor library under
`apps/desktop/src/lib/prosemark-core/` keeps its own licence there. The fonts
keep theirs, beside the font files: `apps/desktop/src-tauri/fonts/`,
`apps/desktop/public/fonts/paper-mono/` and
`apps/desktop/src/features/redline-spike/fonts/`.

## What is here and what is not

- `apps/desktop/src/` is the React frontend.
- `apps/desktop/src-tauri/` is the Rust backend: files, the file watcher, git,
  export, the updater, and the app's calls to Alkuin's servers.
- `apps/desktop/tests/` and `apps/desktop/e2e/` are the tests.
- `docs/` holds engineering notes for the app.

Sign-in, sync, sharing and writing help run on Alkuin's servers. The servers
and the website are separate from the app. They are not in this repository and
they are not open source. The app's side of its calls to them is here, most of
it in `apps/desktop/src-tauri/src/commands/`.

## Run it

You need a Mac, Rust, Node 22.12 or later, and [Vite+](https://viteplus.dev)
(the `vp` command).

```bash
vp install
```

```bash
vp run dev
```

The first compile is slow.

The app opens after sign-in, and this repository has no sign-in service:
Alkuin's is not open source. So a build from here stops at the sign-in screen.
It goes further only if you run a compatible service of your own and name it in
`REDLINE_SUPABASE_URL` and `REDLINE_SUPABASE_ANON_KEY` in the shell that runs
the app. The app's content security policy lets the window reach
`*.supabase.co` and a local `127.0.0.1:54321`, so a service anywhere else also
needs that policy changed in `apps/desktop/src-tauri/tauri.conf.json`. Sync stays off unless `ALKUIN_HISTORY_URL` is set when the Rust crate
is compiled. Usage telemetry is off unless `WRITER_POSTHOG_KEY` is set at
compile time, and then only after the person using the app turns it on.
[docs/telemetry.md](./docs/telemetry.md) lists every event.

## Check a change

```bash
vp check apps/desktop/src apps/desktop/e2e
```

One test reads the built UI, so build it before the tests:

```bash
cd apps/desktop && vp build
```

```bash
vp test
```

The Rust checks run from the Tauri crate:

```bash
cd apps/desktop/src-tauri
```

```bash
cargo fmt --check
```

```bash
cargo clippy --all-targets
```

```bash
cargo test
```

A few of the app's tests are not in this repository, because they run the app
against the servers.

## Build the app

```bash
cd apps/desktop
```

```bash
pnpm exec tauri build --bundles app,dmg
```

The signed and notarized builds on alkuin.app are built from this source with
that command. The signing and notarization that follow use keys that are not
part of the source.

## The name and the logo

The licence covers the code. It does not give you the Alkuin name or logo. If
you distribute your own version, give it a different name and icon, and say
that you changed it.

## Security

Report a security problem to support@alkuin.app. Please do not open a public
issue for it.
