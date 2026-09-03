# pi-widgets

[![CI](https://img.shields.io/github/actions/workflow/status/kyaulabs/pi-widgets/ci.yml?branch=develop)](https://github.com/kyaulabs/pi-widgets/actions)
[![npm](https://img.shields.io/npm/v/@kyaulabs/pi-widgets)](https://www.npmjs.com/package/@kyaulabs/pi-widgets)
[![license](https://img.shields.io/github/license/kyaulabs/pi-widgets)](LICENSE)

Status widgets for [Pi](https://github.com/earendil-works/pi-mono). The package contains two independent extensions:

- `gpt-fast-mode-status.ts` toggles OpenAI's `priority` service tier and shows when Fast mode is active.
- `tps-status.ts` reports token throughput and time to first token (TTFT) in Pi's footer and working line.

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
      "extensions": ["extensions/gpt-fast-mode-status.ts"]
    }
  ]
}
```

Replace the extension path with `extensions/tps-status.ts` to load only the TPS widget.

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

The TPS widget starts a measurement when Pi begins processing a prompt and finalizes it at `agent_settled`. It keeps one measurement across model turns, tool calls, retries, compaction, and queued continuations that belong to the same prompt.

The footer shows tokens per second after output begins. The working line shows TPS and TTFT while Pi is active:

```text
32.4 tok/s · TTFT 684ms
```

The metric uses this calculation:

```text
output tokens / (prompt elapsed time - Bash and PowerShell execution time)
```

Completed responses use the provider's output-token count. While a response is streaming, the widget uses an estimate of one token per four Unicode code points until exact usage is available. TTFT ends at the first streamed text, thinking, or tool-call delta, or at the first positive output-token update.

TPS therefore measures prompt-level throughput, not provider decode speed alone. Non-shell tools, retries, and model wait time remain part of elapsed time.

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
