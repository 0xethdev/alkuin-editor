# Telemetry

Writer can send a small amount of usage data to help decide what to build next.
**It is off until you turn it on.** Nothing is sent before you answer the
first-run prompt, and answering **Not now** sends nothing at all. Either answer
can be changed later in Preferences.

This document covers the desktop app. The website counts visits on its own and
sends nothing here. Its privacy page says how: <https://alkuin.app/privacy#analytics>.

This document is the complete disclosure. If it disagrees with the code, the
code is the bug — the event table below is mirrored in
`apps/desktop/src-tauri/src/telemetry.rs`, which is the only file in the app
that talks to an analytics service.

## Turning it on and off

- **First run** — once you are signed in, a dialog asks for an email for
  release news, with a separate switch for usage data beside it. It does not
  open over the sign-in screen. The switch starts **off**; consent is never
  pre-ticked. **Subscribe** needs the email and applies the switch as you left
  it; **Not now** or Escape takes neither, sends nothing, and clears any email
  already in the settings.
- **Any time after** — Preferences → Privacy → **Share Usage Data** and
  **Email**, each independent of the other.

Turning it off takes effect immediately; nothing is queued for later.

The setting on its own is not consent. Writer keeps _this install's_ answer to
the first-run prompt in `telemetry.json`, as one of four values: `unasked`,
`declined`, `email-only` or `usage`. Usage data is sent only while it is
`usage`. Until the prompt is answered it is `unasked` and nothing is sent,
whatever the settings say — so a `config` file copied from another machine with
the setting turned on does not send anything until you have seen the prompt here
and accepted it.

The answer is written in one step: the two Privacy settings first, then the
answer itself, and only then is anything sent. If that step fails or the app
quits half-way, the prompt is still unanswered and is shown again; nothing was
sent. **Subscribe** with the usage switch off sends only the email, never a
usage event. After the answer, the two Privacy settings are the switches, and
the stored answer follows them.

## What is collected

Five events. That is the whole list.

| Event              | When                                                                        |
| ------------------ | --------------------------------------------------------------------------- |
| `app_opened`       | Once per app launch (or when you first turn telemetry on, if that is later) |
| `workspace_opened` | A workspace becomes active, including restoring your last session at launch |
| `file_created`     | A file is created                                                           |
| `folder_created`   | A folder is created                                                         |
| `email_updated`    | You set, change, or clear the email field — see below                       |

The first four are the usage data, and the **Share Usage Data** switch governs
them entirely. The last is the one exception, and it is deliberate.
`email_updated` is how an address you typed reaches the maintainer, so it is
sent even with usage data off, and only when the field actually changes.

Declining sends nothing. An earlier build sent a `prompt_declined` event on
**Not now**; it was removed because analytics must not run for someone who
said no.

Every event carries the same fixed set of properties, and nothing else:

| Property         | Example           | Notes                                                                                    |
| ---------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `distinct_id`    | `9f2c...`         | Random UUID generated on this install                                                    |
| `app_version`    | `0.5.0`           |                                                                                          |
| `os`             | `macos`           |                                                                                          |
| `arch`           | `aarch64`         |                                                                                          |
| `$geoip_disable` | `true`            | Tells PostHog not to derive a location from the request IP                               |
| `$set.email`     | `you@example.com` | Only if you typed one; attached to your install's record, see below                      |
| `$unset`         | `["email"]`       | Sent instead of `$set.email` when the field is blank, so clearing it clears it there too |

There is no mechanism for passing per-event properties, so a file name or a
snippet of your writing cannot reach the analytics service by accident.

## What is never collected

- The contents of your documents. Telemetry never carries text you write.
- File names, folder names, or any filesystem path.
- Workspace names, search queries, or document counts.
- Your IP is used for nothing beyond delivering the request; no geolocation
  properties are attached.

## The email field

The email is **optional and self-declared**. Writer does not read it from your
system, your git config, or anywhere else — the only way it gets set is if you
type it into the first-run dialog or Preferences → Privacy → **Email**.

If set, it is attached to your install's person record so the maintainer can
tell you about new releases and ask about the features you use.

Setting, changing, or clearing it sends exactly one `email_updated` event
carrying the properties in the table above — including with **Share Usage Data**
off, which is what makes "email me about releases, but send no usage data" a
real option. Clearing the field is the way back to anonymous: that event tells
the analytics service to remove the address from your record rather than merely
stopping to send it. Nothing else is sent while usage data is off. With an
email set, usage data is linked to it, so the record is not anonymous; the
privacy page says so.

## Your identifier

A random UUID is generated the first time telemetry initializes and stored in
`telemetry.json` in Writer's application data directory, alongside your answer
to the first-run prompt (`consent`). The file also keeps a `prompted` flag so an
older version of Writer reads the same answer; a file written before `consent`
existed is read from that flag and your Privacy settings.

It is deliberately kept out of your `config` file: that file is human-editable
and is the kind of thing people copy between machines, and an identifier living
there would silently merge two installs into one "user". Delete `telemetry.json`
to get a new identifier and to see the first-run prompt again; until you answer
it, nothing is sent, whatever the setting says.

## Where it goes

PostHog Cloud (US region, `https://us.i.posthog.com`), via a single
`POST /batch/`.

## Turning it off for good

Three independent switches, any one of which is sufficient:

1. **Don't enable it.** This is the default.
2. **`WRITER_TELEMETRY_DISABLED=1`** (any non-empty value) in the environment
   disables telemetry at runtime regardless of your settings — the client is never constructed, so no
   identifier is generated and nothing is written to disk. It is read at
   startup, so it applies from the next launch onward. Intended for distro
   packagers and for anyone running a build they did not make themselves.
3. **Build it yourself.** The PostHog project key is supplied at compile time
   via `WRITER_POSTHOG_KEY`. A build without that variable — which is what you
   get by cloning this repo and running `vp run dev` or `cargo build` — has no key
   compiled in, never constructs the client, never generates an identifier, and
   never shows the consent prompt, whatever the settings say.

`WRITER_POSTHOG_HOST` overrides the destination if you run your own PostHog.

## For contributors

Dev builds are inert by default (no key), so local work never pollutes
production analytics. To exercise the real path against your own PostHog
project:

```bash
WRITER_POSTHOG_KEY=phc_your_project_key vp run dev
```

Adding an event means editing three things in the same commit: the `track` call
site, the table in this file, and the `COLLECTED` list in
`apps/desktop/src/components/telemetry-consent-dialog.tsx`. If a change would
make any of those three disagree, it needs a different design.

Consent works the same way. The dialog answers through one IPC,
`telemetry_answer` (`declined`, `email-only` or `usage`), and nothing else may
write the consent record. A change to what an answer writes or sends touches
`Consent` and `answer_with` in `telemetry.rs`, the dialog, and the section
above, together.
