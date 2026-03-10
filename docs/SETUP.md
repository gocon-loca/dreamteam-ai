# Setting Up DreamTeam

This guide has three paths. Pick the one that feels right for you.

| Path | You are... | Time |
|------|-----------|------|
| [Gentle Introduction](#path-1-gentle-introduction) | New to GitHub, terminals, and/or AI tools. Maybe feeling a bit of "this is a lot." | 45-60 min |
| [Streamlined Setup](#path-2-streamlined-setup) | Technical enough but easily overwhelmed by long setup docs. You want the steps without the noise. | 20-30 min |
| [Developer Quick Setup](#path-3-developer-quick-setup) | You've done this a hundred times. Just give you the commands. | 10 min |

No matter which path you pick, you'll end up in the same place: DreamTeam running on your machine, connected to Telegram, ready to work on your projects.

---

## Path 1: Gentle Introduction

**This section is for you if:** you're newer to this kind of tooling, you've felt intimidated by setup guides before, or you just want someone to walk you through it without assuming you know what `PATH` means.

You've got this. Seriously. Every developer you've ever admired has copy-pasted commands from a README without fully understanding them. That's normal. That's fine.

### What we're going to do (the big picture)

We're going to:
1. Install some software on your computer
2. Create a Telegram bot (it's surprisingly easy — just text a bot)
3. Get an API key so DreamTeam can use Claude
4. Tell DreamTeam where your projects live
5. Start it up

That's it. Five things. Let's go one at a time.

### Step 1: Run the bootstrap script

Open Terminal (on Mac: press Cmd+Space, type "Terminal", hit Enter) and paste this one command:

```
curl -fsSL https://raw.githubusercontent.com/gocon-loca/dreamteam-ai/main/scripts/bootstrap.sh | bash
```

This will automatically:
- Install Homebrew (Mac's package manager, if you don't have it)
- Install Node.js 22 (the engine that runs DreamTeam)
- Install pnpm (manages DreamTeam's dependencies)
- Install Claude Code CLI (the AI that does the actual coding)
- Download DreamTeam's code
- Install all dependencies

Just follow any prompts that appear. When it finishes, it'll ask if you want to launch the setup wizard — say yes!

> **If the script gets stuck or gives an error**, copy the error text and paste it into ChatGPT or Claude: "I'm setting up DreamTeam and got this error." They're great at debugging install issues.

> **Prefer to do it manually?** See [Step 1 (manual)](#step-1-manual-install) at the bottom of this page.

### Step 3: Create your Telegram bot

This part is actually fun:

1. Open Telegram on your phone
2. Search for `@BotFather` (it's Telegram's official bot for making bots)
3. Send `/newbot`
4. Give it a name like "My DreamTeam"
5. Give it a username like `my_dreamteam_bot` (must end in `bot`)
6. BotFather will give you a **token** — it looks like `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`. Save this!

Now get your Telegram user ID:
1. Search for `@userinfobot` in Telegram
2. Send it any message
3. It'll reply with your user ID (a number). Save this too!

### Step 4: Get a Claude API key

You need an API key so DreamTeam can use Claude to write code. You have options:

**Option A: Anthropic API (pay-per-use)**
- Go to [console.anthropic.com](https://console.anthropic.com)
- Create an account and add a payment method
- Go to API Keys → Create Key
- Save the key (starts with `sk-ant-`)

**Option B: Use Claude Pro/Max subscription**
- If you have a Claude Pro ($20/mo) or Max ($100/mo) plan, Claude Code CLI can use your subscription directly
- Run `claude` in your terminal and log in with your account
- No API key needed — Claude Code will use your plan's allowance

See [COSTS.md](COSTS.md) for help picking the most cost-effective option.

### Step 5: Configure DreamTeam

Copy the template files:
```
cp config/secrets.template.yaml config/secrets.yaml
cp .env.example .env
```

Open `config/secrets.yaml` in any text editor and fill in:
- Your Telegram bot token (from Step 3)
- Your Telegram user ID (from Step 3)

Open `config/projects.yaml` and update the project paths to point to YOUR projects on YOUR computer. The format is:
```yaml
projects:
  my-project:
    path: ~/path/to/my/project
    description: "What this project does"
    hasDevServer: false
```

> **Heads up:** The `path` should be the folder where your project's code lives. The `~` means your home folder.

Now encrypt your secrets (so they're not stored as plain text):
```
# Generate an encryption key
age-keygen -o config/age-key.txt

# Encrypt your secrets file
SOPS_AGE_KEY_FILE=./config/age-key.txt sops --encrypt config/secrets.yaml > config/secrets.enc.yaml

# Delete the unencrypted version
rm config/secrets.yaml
```

> **Don't have `age` or `sops`?** AI can help! Paste this into Claude or ChatGPT: "How do I install age-keygen and sops on [Mac/Windows/Linux]?" On Mac with Homebrew it's just `brew install age sops`.

### Step 6: Build and run

```
pnpm build
node dist/bot/index.js
```

Open Telegram. Send `/start` to your bot. If it responds, you're in business!

To start the full autonomous system:
```
node dist/daemon/supervisor.js
```

Or send `/startwork` from Telegram.

### You did it!

Send `/goal my-project Fix the login button` to create your first goal, then `/startwork` to watch it go.

If something went wrong, that's normal. Copy the error message, paste it into Claude or ChatGPT, and describe what you were doing. Setup debugging is one of the things AI is best at.

---

## Path 2: Streamlined Setup

**This section is for you if:** you know your way around a terminal but long setup guides make your eyes glaze over. You want clear steps, no fluff, but with enough context to not get lost.

### Prerequisites
- Node.js 22+ (`node --version`)
- pnpm (`npm install -g pnpm`)
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- sops + age (`brew install sops age` on Mac)

### Get the code
```bash
git clone https://github.com/gocon-loca/dreamteam-ai.git
cd dreamteam-ai
pnpm install
```

### Create Telegram bot
1. Message `@BotFather` on Telegram → `/newbot` → get your **bot token**
2. Message `@userinfobot` → get your **user ID**

### Configure
```bash
# Copy templates
cp config/secrets.template.yaml config/secrets.yaml
cp .env.example .env

# Edit secrets.yaml — add bot token + user ID
# Edit config/projects.yaml — update paths to your projects

# Generate encryption key and encrypt secrets
age-keygen -o config/age-key.txt
SOPS_AGE_KEY_FILE=./config/age-key.txt sops --encrypt config/secrets.yaml > config/secrets.enc.yaml
rm config/secrets.yaml
```

### Claude API access

**Pick one:**
- **API key**: Get from [console.anthropic.com](https://console.anthropic.com), set `ANTHROPIC_API_KEY` in your environment
- **Pro/Max plan**: Run `claude` and log in — Claude Code uses your subscription

### Build and run
```bash
pnpm build

# Bot only (Telegram interface):
node dist/bot/index.js

# Full system (supervisor + workers):
bash scripts/start.sh
# Or use PM2 for process management:
npm install -g pm2
pm2 start dist/daemon/supervisor.js --name supervisor
pm2 start dist/daemon/worker.js --name worker-0
```

### Verify
- Send `/start` to your bot on Telegram
- Send `/status` — should show system overview
- Send `/goal my-project Something small` to test goal creation
- Send `/startwork` to begin autonomous dispatch

### Project config reference

In `config/projects.yaml`:
```yaml
projects:
  my-app:
    path: ~/code/my-app              # Where the code lives
    description: "My web app"        # Human label
    hasDevServer: true               # Set true if it has a dev server
    devCommand: "npm run dev"        # How to start it
    devPort: 3000                    # What port it runs on
    healthCheck: "http://localhost:3000"  # URL to verify it's up
```

Each project should have its own `CLAUDE.md` in its root directory — that's how you tell the agents about your project's conventions.

---

## Path 3: Developer Quick Setup

```bash
git clone https://github.com/gocon-loca/dreamteam-ai.git && cd dreamteam-ai
pnpm install

# Telegram: @BotFather /newbot → token; @userinfobot → user ID
cp config/secrets.template.yaml config/secrets.yaml
# Fill in telegram.botToken and telegram.allowedUsers

# Update config/projects.yaml with your project paths

# Encrypt secrets
age-keygen -o config/age-key.txt
SOPS_AGE_KEY_FILE=./config/age-key.txt sops --encrypt config/secrets.yaml > config/secrets.enc.yaml
rm config/secrets.yaml

# Claude access: either set ANTHROPIC_API_KEY or run `claude` to auth via subscription
pnpm build

# Run
pm2 start dist/bot/index.js --name bot
pm2 start dist/daemon/supervisor.js --name supervisor
pm2 start dist/daemon/worker.js --name worker-0
pm2 start dist/daemon/worker.js --name worker-1
pm2 start dist/daemon/worker.js --name worker-2

# Verify: /start, /status, /goal my-project test-goal, /startwork
```

### Key config files
| File | Purpose |
|------|---------|
| `config/projects.yaml` | Project registry (paths, dev servers, ports) |
| `config/secrets.enc.yaml` | Encrypted Telegram token + test accounts |
| `.env` | Environment overrides |
| `CLAUDE.md` | Full system documentation |
| `WORKFLOW.md` | Agent behavior rules for DreamTeam itself |

### Architecture
- **Supervisor** (`src/daemon/supervisor.ts`) — dispatch loop, quality gates, periodic tasks
- **Worker** (`src/daemon/worker.ts`) — claims goals, spawns Claude CLI, manages branches
- **Goal Manager** (`src/orchestration/goal-manager.ts`) — CRUD, validation, post-completion hooks
- **Prompt Builder** (`src/scheduler/prompt-builder.ts`) — builds context-rich prompts per goal
- **Model Router** (`src/orchestration/model-router.ts`) — haiku → sonnet → opus ladder

---

## Adding your projects

DreamTeam works with **any project** that has code in a git repository. For best results:

1. **Add a CLAUDE.md** to your project's root — describe your stack, conventions, key files, and "don't do" rules. This is the single most impactful thing you can do. The agents read it first.

2. **Add a WORKFLOW.md** (optional) — structured YAML front matter with project-specific rules, failure modes, and completion checklists. See `templates/WORKFLOW.md.example` for the format.

3. **Register it** in `config/projects.yaml` with at minimum a `path` and `description`.

4. **If it has a dev server**, set `hasDevServer`, `devCommand`, `devPort`, and `healthCheck` so DreamTeam can run smoke tests.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot doesn't respond | Check bot token in secrets. Check `pm2 logs bot` for errors. |
| "No pending goals" | Create a goal first with `/goal project-name title`. |
| Goals stay pending | Run `/startwork` or check `/status` for paused state. |
| Workers crash | Check `pm2 logs worker-0`. Usually a missing env var or bad project path. |
| High costs | Set a budget with `/budget 10` (dollars/day). Use routine complexity for small goals. |
| Circuit breaker tripped | A project had 3 consecutive failures. `/resume project-name` to reset. |

> **Still stuck?** Paste your error into Claude or ChatGPT with context like: "I'm setting up DreamTeam, an autonomous coding system. I ran [command] and got [error]." AI is extremely good at debugging setup issues — that's literally what it's built for.
