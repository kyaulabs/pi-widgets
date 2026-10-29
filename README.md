# pi-widgets

[![CI](https://img.shields.io/github/actions/workflow/status/kyaulabs/pi-widgets/ci.yml?branch=develop)](https://github.com/kyaulabs/pi-widgets/actions)
[![npm](https://img.shields.io/npm/v/@kyaulabs/pi-widgets)](https://www.npmjs.com/package/@kyaulabs/pi-widgets)
[![license](https://img.shields.io/github/license/kyaulabs/pi-widgets)](LICENSE)

Status widgets for [Pi](https://github.com/earendil-works/pi-mono). The package contains two independent extensions:

- `fast-mode.ts` requests OpenAI's Fast, Ultrafast, and Flex service tiers and shows the tier reported by the server.
- `tps.ts` reports request-average output throughput and first-server-event latency (displayed as TTFT) in Pi's footer and working line.

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

Fast mode is disabled by default. Run `/fast` or press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd> to toggle it for the current session. The footer initially shows ` Fast (requested)`.

Fast mode supports `gpt-6.1-terra` and `gpt-5.3-codex` in addition to the existing
supported models on both `openai` and `openai-codex`.

When the selected model is supported, the extension sends the API-compatible
`priority` value for Fast mode in the matching provider request:

```json
{
  "service_tier": "priority"
}
```

Run `/ultrafast` to request `service_tier: "ultrafast"` for `gpt-6-astra`,
`gpt-6.1-sol`, or `gpt-5.6-sol` on either provider. The footer shows `⚡ Ultrafast`
in purple, initially with `(requested)`. OpenAI documents general API availability
for GPT-6 Astra and [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol);
the retained GPT-5.6 Sol support requires preview access. Both tiers cost more than Standard;
see OpenAI's [Fast](https://developers.openai.com/api/docs/guides/fast-mode) and
[Ultrafast](https://developers.openai.com/api/docs/guides/ultrafast-mode) guides
for pricing and availability restrictions. Provider authentication and account
access still determine whether a request is accepted. Pi's `openai-codex` provider
uses ChatGPT OAuth, a separate service from the public OpenAI API. Public API
availability does not guarantee the same tier access through ChatGPT OAuth.

Run `/flex` to request `service_tier: "flex"`, with a green `󰿗 Flex` footer status.
Flex offers lower costs in exchange for slower responses and occasional resource
unavailability. The extension uses the model list in OpenAI's
[Flex pricing table](https://developers.openai.com/api/docs/pricing?latest-pricing=flex):
`gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`,
`gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4-pro`, `gpt-5.2`, `gpt-5.1`, `gpt-5`,
`gpt-5-mini`, `gpt-5-nano`, `o3`, and `o4-mini`, on either provider.
See the [Flex guide](https://developers.openai.com/api/docs/guides/flex-processing?api-mode=responses)
for availability and timeout guidance. This command does not change provider
timeouts or retries, or automatically fall back to a higher-cost tier.

All three modes are mutually exclusive: enabling one replaces the other. Running the
active mode's command again disables it. The existing shortcut toggles Fast only.
Unsupported models and mismatched payloads are left unchanged, with a warning
when the selected mode does not support the current model.

On the public `openai` API, the footer keeps `(requested)` until `response.completed`
reports a `service_tier`. A matching tier removes that suffix. If the server reports
a different tier, the footer shows, for example, `Fast → default`, and the extension
warns. Missing tier metadata leaves the request unverified with `(requested)`.

On `openai-codex` (ChatGPT sign-in), the footer keeps `(requested)` and does not warn
about response-tier mismatches. OpenAI explains that
[Codex response tiers do not reliably confirm Fast routing](https://github.com/openai/codex/issues/14204#issuecomment-4033184620):
`default` does not mean Fast was ignored. `/fast status` preserves the raw reported
value and notes that it does not confirm the applied tier. This applies to all three
speed modes; the extension does not infer execution or billing from Codex metadata.

Unsupported models show `Fast (unsupported)`, `Ultrafast (unsupported)`, or
`Flex (unsupported)`. Run `/fast status` to inspect the selected model, requested tier,
and last reported tier without toggling the mode. Requesting a tier alone does not
establish a speed increase.

Reasoning effort is a separate native Pi setting. In Pi 1.3 or newer, use
`/thinking max` for the current session, or start with `pi --thinking max`.
`/thinking` lists the levels supported by the selected model. The GPT-6 family
(`gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, and `gpt-6-luna`) supports `max`.
This is the highest public API reasoning effort. Codex and ChatGPT also offer
[Ultra](https://learn.chatgpt.com/docs/agent-configuration/subagents), which combines
maximum reasoning with proactive parallel subagents. Pi does not expose that
orchestration preset; sending `reasoning.effort: "ultra"` is not its equivalent.
Ultrafast is an independent speed setting and works with `max` reasoning.
Available levels depend on the model, and changing service tiers does not change
reasoning effort.

### Supported models

The extension enables Fast requests on `openai` and `openai-codex` for the models
in OpenAI's [Fast pricing table](https://developers.openai.com/api/docs/pricing?latest-pricing=fast):

- `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-luna`
- `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`
- `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.2`, `gpt-5.1`, `gpt-5`, `gpt-5-mini`
- `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-4o`, `gpt-4o-2024-05-13`, `gpt-4o-mini`
- `o3`, `o4-mini`

The existing `gpt-5.6` alias remains supported. Unlisted models are not enabled automatically.

### Default state

Set the startup state under `pi-gpt-fast-mode` in `~/.pi/agent/settings.json`:

```json
{
  "pi-gpt-fast-mode": {
    "enabled": true
  }
}
```

The `/fast`, `/ultrafast`, and `/flex` commands change only the current session.
A new session reloads the configured Fast default; Ultrafast and Flex are never
enabled automatically.

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

The TPS widget measures **request-average output throughput**, not pure decoding speed.
For each response, timing starts at `before_provider_request` and stops at the assistant's
`message_end`. The denominator includes the wait before content, hidden reasoning, streaming,
and response finalization, excluding the observable pauses listed below.

Previously, the widget divided the final output count by time after the first content delta.
Pi's OpenAI Responses providers, including `openai-codex`, copy `output_tokens` to `usage.output`
and its reasoning breakdown to `usage.reasoning`. Output already includes hidden reasoning.
Counting that reasoning over only the later content burst inflated TPS.

For example, a 10-second request wait followed by 100 output tokens in 2 seconds now produces
**8.3 tok/s**. TTFT is measured independently from the first server event, not from that content
burst. A local file read before the request counts toward neither.

The calculation is:

```text
sum of output tokens from measurable responses / sum of their matching timed request seconds
```

Each response includes its own initial wait. The footer aggregates across the prompt's
responses until `agent_settled`; it never averages individual rates. It freezes between
requests. The working-line suffix is removed during pauses, leaving Pi's tool, compaction,
and retry indicators alone. A finalized measurement might look like:

```text
32.4 tok/s · TTFT 700ms
```

The UI labels **first-server-event latency** as `TTFT`. It runs from `before_provider_request`
to the first parsed `provider_stream_event`, using the same pause-adjusted request clock, and
resets for each response. This is not necessarily time to a generated token, visible prose, or
the first network byte: `response.created` can establish this measurement without any content.
Text, thinking, and tool-call deltas do not establish TTFT; first-content latency is not displayed.

TTFT is hidden until a raw event is observed, or when the Pi host/provider lacks the necessary
hooks. It never uses a fabricated zero or substitutes content arrival for a missing raw event.
Buffered/nonstreaming responses with a request hook and positive output usage can contribute
throughput while TTFT remains hidden. Without a request hook, neither request
throughput nor latency is inferred from `message_start`. `/tps ttft` and `showTTFT` control this
single latency value.

Live counts use one estimated token per four Unicode code points in text, thinking, and tool-call
argument deltas, rounded up per response. They use the full timed request, not a post-content
window. Partial usage can be stale and is ignored. A positive final `usage.output` replaces
that response's estimate. Missing, invalid, or zero-placeholder usage retains the estimate.
The display always uses plain `tok/s`, without average or estimate prefixes; live counts and
aggregates containing fallback counts are still estimates. Hidden reasoning is unobservable in
these estimates, so final usage can change the rate substantially. While waiting without
content, the previous aggregate remains unchanged.

The widget uses each provider's declared output total without adding or subtracting
`usage.reasoning`. Reasoning metadata can be missing or zero, and subtracting it is not a
provider-independent count of streamed content. Input/cache tokens, tool results, nested
model calls during tools, and compaction/branch-summary usage do not contribute.
Responses without a matching request window, with less than 50 ms of timed request duration,
or without positive usage or an observed output estimate contribute neither tokens nor time.

Throughput and latency exclude:

- Tool execution, including parallel/custom tools, permission gates, and result hooks.
- Manual, automatic, failed, and cancelled compactions, plus branch summarization.
- Prompt/context preparation and authentication before the provider-request hook.
- Blocking extension UI prompts and gaps between requests.
- Observable retry backoff, queued-continuation preparation, and idle time.

Retries within an open response retain the observed attempt time before a non-success HTTP
response. Timing pauses at that response and resumes at a repeated request hook, excluding
backoff. Final usage replaces the response's estimate once, not once per attempt. Latencies
are measured from the initial hook over these accumulated attempt intervals. If success headers,
a raw stream event, or content arrive without a new request hook, retry latency cannot be
separated from backoff: that response's timing becomes unknown and its throughput sample is
excluded. Previous aggregates remain intact. Pi-level retries after a response closes start a
new response window; the gap is excluded.

Cancellation stops the timer immediately and retains only a measurable estimate of content
observed before cancellation. Late events cannot add finalized usage to that closed window.
An interrupted response retains an observed first-server-event TTFT; without that event,
TTFT remains hidden.

**Accuracy limits:** these are client-observed measurements. Chunking, buffering, network delay,
and finalization affect them; hidden provider-internal retries/reconnects without observable
boundaries remain inside the timed request. Older Pi hosts and custom providers may lack hooks.
Historical total response durations are not TTFT measurements. This reporting fix does not
eliminate provider latency, establish the cause of reported long stalls, or change transport,
authentication, reasoning effort, or service tier.

### Commands

| Command | Effect |
| --- | --- |
| `/tps` or `/tps status` | Show the current measurement and display settings. |
| `/tps on` | Enable all TPS metrics. |
| `/tps off` | Disable all TPS metrics. |
| `/tps toggle` | Toggle all TPS metrics. |
| `/tps bar on\|off\|toggle` | Control the footer value. |
| `/tps line on\|off\|toggle` | Control the working-line suffix. |
| `/tps ttft on\|off\|toggle` | Control first-server-event TTFT in the working line. |
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
| `enabled` | boolean | `true` | Enable throughput and latency measurement output. |
| `statusBar` | boolean | `true` | Show TPS in Pi's footer. |
| `workingLine` | boolean | `true` | Show live metrics beside Pi's working indicator. |
| `showTTFT` | boolean | `true` | Include first-server-event TTFT in the working line. |
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

When [pi-zentui](https://github.com/lmilojevicc/pi-zentui) advertises working-line segment support, the widget sends throughput and latency as a named `tps` segment instead of replacing Pi's working message. It also emits the matching status color before each footer update. Without Zentui, it uses Pi's standard status and working-message APIs.

## Data handling

Both extensions run inside the Pi process with the permissions granted to Pi.

The Fast mode extension reads `settings.json` and `keybindings.json`. It changes only matching provider payloads while a service-tier mode is enabled. The TPS extension reads `settings.json` and observes lifecycle, message-usage, and tool-execution events. It does not write settings, session data, prompts, responses, or metrics to disk, and it does not send telemetry.

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
