# pi-widgets

[![CI](https://img.shields.io/github/actions/workflow/status/kyaulabs/pi-widgets/ci.yml?branch=develop)](https://github.com/kyaulabs/pi-widgets/actions)
[![npm](https://img.shields.io/npm/v/@kyaulabs/pi-widgets)](https://www.npmjs.com/package/@kyaulabs/pi-widgets)
[![license](https://img.shields.io/github/license/kyaulabs/pi-widgets)](LICENSE)

Status widgets for [Pi](https://github.com/earendil-works/pi-mono). The package contains two independent extensions:

- `fast-mode.ts` toggles OpenAI's `priority` service tier and shows when Fast mode is active.
- `tps.ts` reports token throughput and time to first token (TTFT) in Pi's footer and working line.

## Requirements

- Node.js 22.19.0 or newer
- Pi 0.84.4 or newer

The package is tested against Pi 0.84.4. Pi loads the TypeScript files directly, so there is no build step or generated runtime code.

## Install

Install both extensions from npm:

```sh
pi install npm:@kyaulabs/pi-widgets
```

A Git checkout also works:

```sh
pi install git:github.com/kyaulabs/pi-widgets
```

For local development, point Pi at the checkout:

```sh
pi install /path/to/pi-widgets
```

Restart Pi after installation. Use `/reload` after editing a locally installed checkout.

### Load only one extension

Pi package filters can select a single widget. Add the package in object form to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "npm:@kyaulabs/pi-widgets",
      "extensions": ["extensions/fast-mode.ts"]
    }
  ]
}
```

Replace the extension path with `extensions/tps.ts` to load only the TPS widget.

If upgrading from the old filenames, update explicit extension paths and package filters to
`extensions/fast-mode.ts` and `extensions/tps.ts`. Remove any manually copied old files to avoid
loading duplicate widgets. Commands, settings keys, and shortcuts are unchanged.

## GPT Fast mode

Fast mode is disabled by default. Run `/fast` or press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd> to toggle it for the current session. The ` Fast` footer status appears while it is enabled.

When the selected model is supported, the extension adds this field to the matching provider request:

```json
{
  "service_tier": "priority"
}
```

The extension leaves unsupported models and mismatched payloads unchanged. It warns when Fast mode is enabled while the current model is unsupported.

### Supported models

Both the `openai` and `openai-codex` providers support these model IDs:

- `gpt-5.4`
- `gpt-5.4-mini`
- `gpt-5.5`
- `gpt-5.6`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`

### Default state

Set the startup state under `pi-gpt-fast-mode` in `~/.pi/agent/settings.json`:

```json
{
  "pi-gpt-fast-mode": {
    "enabled": true
  }
}
```

The `/fast` command changes only the current session. A new session reloads the configured default.

### Shortcut

Set one shortcut, several shortcuts, or `false` in `~/.pi/agent/keybindings.json`:

```json
{
  "pi-gpt-fast-mode": ["ctrl+alt+m", "alt+f"]
}
```

```json
{
  "pi-gpt-fast-mode": false
}
```

The default is `ctrl+alt+m`. The extension ignores `ctrl+m`, `enter`, and `return` because those keys submit input in common terminal configurations. Empty or invalid scalar values restore the default shortcut.

## TPS and TTFT status

The TPS widget measures **observed generation speed**: how fast the AI produces output once
it starts. For each response, TPS timing starts at the first nonempty text, thinking, or
tool-call argument delta and stops at the assistant's `message_end`. The initial wait is
shown separately as TTFT, not included in TPS.

For example, 10 seconds processing a large file followed by 100 output tokens generated in
2 seconds produces **50.0 tok/s**, with **TTFT 10.0s**. Reading the file itself counts toward neither.

The footer shows tokens per second after output begins and freezes between requests. The
working-line suffix is removed while the meter is paused, leaving Pi's normal tool, compaction,
and retry indicators alone. During a request it shows TPS and TTFT:

```text
32.4 tok/s · TTFT 684ms
```

The metric uses this calculation:

```text
output tokens from measurable responses / their accumulated generation seconds
```

The initial wait is excluded **on every response**, including the request after a large file
read. The footer keeps a generation-time-weighted aggregate across the prompt's responses,
finalized at `agent_settled`, rather than averaging individual rates.

Live output is estimated internally at one token per four Unicode code points.
Partial provider usage is not trusted as a current total: it can remain stale while more text
arrives. At completion, a positive provider-reported output count replaces that response's
estimate. Missing, invalid, or zero-placeholder usage retains the estimate.
The UI always uses plain `tok/s` and `TTFT`, without estimate labels or approximation symbols;
this display choice does not make live or fallback token counts exact.

Text, thinking, and tool-call argument generation count as assistant output; input/cache tokens,
tool results, nested tool-model usage, and compaction/branch-summary usage do not. Reasoning
usage is already included in provider output totals and is never added a second time.

Responses without an observed content delta, or with less than 50 ms of observed generation,
are excluded from both the numerator and denominator. This avoids inventing a rate from a
final-only usage report or folding untimed tokens into later responses.

Both TPS and TTFT exclude:

- All tool execution, including parallel/custom tools, permission gates, and result hooks.
- Manual, automatic, failed, and cancelled compactions, plus branch summarization.
- Prompt/context preparation and credential resolution before the provider-request hook.
- Blocking extension UI prompts and gaps between model requests.
- Pi's automatic retry backoff, queued-continuation preparation, and idle time.

TTFT runs from `before_provider_request` to the first content delta, excluding observable
pauses. It resets for each response, so it reflects the current request's initial wait.
Usage-only events never invent a first-token timestamp. An aborted response without output
does not leave a TTFT counter running. Cancellation stops timing immediately and retains
only a measurable estimate of output observed before cancellation.

Observable non-success HTTP responses pause timing until the next request hook or successful
response/stream start. If a provider retries without another request hook, retry pre-response
latency cannot be separated from backoff and is excluded from TTFT too. Custom providers
without a payload hook can still yield generation TPS, but TTFT is omitted as unavailable.

**Accuracy limits:** this is a client-observed rate, not exact server-side decoding speed.
Pi streams chunks, not individually timestamped tokens. The formula uses the whole response's
output count, including its first chunk, over the observed first-delta-to-completion interval.
Network buffering, hidden reasoning before the first delta, and response-finalization latency
can skew the result, particularly for short responses. Hidden provider-internal retries or
reconnects after output starts cannot reliably be separated from generation. Delays before
output starts never lower TPS.

### Commands

| Command | Effect |
| --- | --- |
| `/tps` or `/tps status` | Show the current measurement and display settings. |
| `/tps on` | Enable all TPS metrics. |
| `/tps off` | Disable all TPS metrics. |
| `/tps toggle` | Toggle all TPS metrics. |
| `/tps bar on\|off\|toggle` | Control the footer value. |
| `/tps line on\|off\|toggle` | Control the working-line suffix. |
| `/tps ttft on\|off\|toggle` | Control TTFT in the working line. |
| `/tps help` | Show command help. |

Command changes last for the current session.

### Persistent settings

Set defaults under `pi-tps-status` in `~/.pi/agent/settings.json`:

```json
{
  "pi-tps-status": {
    "enabled": true,
    "statusBar": true,
    "workingLine": true,
    "showTTFT": true,
    "refreshMs": 250
  }
}
```

| Setting | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Enable TPS and TTFT measurement output. |
| `statusBar` | boolean | `true` | Show TPS in Pi's footer. |
| `workingLine` | boolean | `true` | Show live metrics beside Pi's working indicator. |
| `showTTFT` | boolean | `true` | Include TTFT in the working line. |
| `refreshMs` | number | `250` | Refresh interval, rounded and clamped to 100–2000 ms. |

Invalid values use their defaults. Missing or malformed settings files do not stop the extension from loading.

### Colors and Zentui

The footer color moves through these throughput ranges:

- 15 tok/s or less: red
- 15–40 tok/s: red through yellow to green (`#1aaa13`)
- 40–75 tok/s: green to cyan (`#4dc5dc`)
- 75–100 tok/s: cyan to purple (`#73488b`)
- 100 tok/s or more: purple

Standard Pi output uses 24-bit ANSI color.

When [pi-zentui](https://github.com/lmilojevicc/pi-zentui) advertises working-line segment support, the widget sends TPS and TTFT as a named `tps` segment instead of replacing Pi's working message. It also emits the matching status color before each footer update. Without Zentui, it uses Pi's standard status and working-message APIs.

## Data handling

Both extensions run inside the Pi process with the permissions granted to Pi.

The Fast mode extension reads `settings.json` and `keybindings.json`. It changes only matching provider payloads while Fast mode is enabled. The TPS extension reads `settings.json` and observes lifecycle, message-usage, and tool-execution events. It does not write settings, session data, prompts, responses, or metrics to disk, and it does not send telemetry.

## Development

Install dependencies and activate the tracked Git hooks:

```sh
npm install
npm run hooks:install
```

Run the same checks used by CI:

```sh
npm run check
npm pack --dry-run
```

`npm run check` lints and type-checks the extensions, then runs coverage with 98 percent minimums for statements, branches, functions, and lines. The pre-commit hook also requires [Gitleaks](https://github.com/gitleaks/gitleaks).

See [CONTRIBUTING.md](CONTRIBUTING.md) for test and pull-request requirements.

## License

Copyright © KYAU Labs. Licensed under the [GNU Affero General Public License v3.0](LICENSE).
