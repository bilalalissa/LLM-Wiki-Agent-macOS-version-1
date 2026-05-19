# Local `.env` And `.gitignore` Setup

The GitHub upload intentionally excludes files whose names start with `.`. That means users create local `.env` and `.gitignore` files after cloning or downloading the project.

## Create `.env`

Copy the public template:

```bash
cp config.example.env .env
```

Then edit `.env` and set:

```text
VAULTS_ROOT=/absolute/path/to/your/Obsidian-Vaults
DEFAULT_AI_PROVIDER=openai_subscription
DEFAULT_AI_MODEL=gpt-5.4
OPENAI_AUTH_METHOD=subscription
OPENAI_SUBSCRIPTION_CLIENT=codex
OPENAI_CODEX_COMMAND=codex
```

For ChatGPT subscription mode, also run:

```bash
codex login
codex login status
```

For API-key mode, use the matching provider instead:

```text
DEFAULT_AI_PROVIDER=openai
OPENAI_AUTH_METHOD=api_key
OPENAI_API_KEY=your-key-here
```

Never commit `.env`. It may contain API keys, tokens, local paths, or personal configuration.

## Create `.gitignore`

Create a local `.gitignore`:

```bash
touch .gitignore
```

Recommended content:

```gitignore
.env
.env.*
.DS_Store
.llm-wiki/
build/
release-template/
node_modules/

# Local vaults and user data
*-vault/

# Local app config copies
config.env
```

If you want to commit sample vault scaffolds later, put them in a non-private folder such as `examples/` instead of committing real vaults.

## Check Before Upload

Before uploading to GitHub, verify no dotfiles or secrets are included:

```bash
find . -name '.*' -print
rg -n "sk-|api_key|API_KEY|TOKEN|/Users/" .
```

For this project, the safer path is:

```bash
./scripts/prepare_github_release.sh
```

Then upload:

```text
release-template/llm-wiki-agent/
```
