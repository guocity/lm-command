# lm-command

`lm-command` is a small Node command wrapper around `litert-lm`.

It gives you a global `lm` command that:

- auto-finds your `.litertlm` model in the Hugging Face cache
- remembers the last backend you saved (`cpu` or `gpu`)
- remembers the resolved model path on disk
- installs `uv` automatically if it is missing
- prepares `litert-lm` with `uvx` on first use
- shells out to `uvx --from litert-lm litert-lm ...`

## Install

```bash
npm install -g lm-command
```

For local development inside this folder:

```bash
npm install
npm link
```

## Publish to npm

Preferred: export `NPM_TOKEN` in your shell profile:

```bash
export NPM_TOKEN=your_token_here
```

Then publish:

```bash
npm run publish:npm
```

Fallback: log in interactively:

```bash
npm login
```

Then publish with the same script:

```bash
npm run publish:npm
```

Dry run:

```bash
npm run publish:npm:dry-run
```

The publish script will:

- use `NPM_TOKEN` from the environment when available
- otherwise fall back to your existing npm login
- check whether the package name already exists
- run `npm pack --dry-run`
- publish with `--access public`

## Usage

Run a prompt:

```bash
lm "hello from litert"
```

If this is your first time, `lm` will make sure `uv` is available and prepare `litert-lm`.
If no model has been downloaded yet, it will tell you to run:

```bash
lm download
```

Use a specific backend for this run and save it for future runs:

```bash
lm backend gpu
lm "write a haiku about local models"
```

Fresh installs default to `gpu`.

Set the model path manually:

```bash
lm model /full/path/to/gemma-4-E2B-it.litertlm
```

Force auto-discovery again:

```bash
lm model auto
```

See the saved config:

```bash
lm status
```

Download the default model and save the discovered path:

```bash
lm download
```

Or download a different LiteRT model repo:

```bash
lm download litert-community/gemma-4-E2B-it-litert-lm
```

## Saved config

The CLI stores its config in:

```bash
~/.config/lm-command/config.json
```

The saved JSON includes:

- `backend`
- `modelPath`

## Equivalent wrapped command

When you run:

```bash
lm "hello"
```

this tool effectively executes:

```bash
uvx --from litert-lm litert-lm run -b gpu /path/to/model.litertlm --prompt "hello"
```

## Notes

- `uv` is installed automatically when possible.
- If no saved model exists, the CLI scans `~/.cache/huggingface/hub` by default.
- `HUGGINGFACE_HUB_CACHE`, `HF_HOME`, and `XDG_CONFIG_HOME` are respected when set.
