# DreamTeam Quick Start

Get DreamTeam running in under 15 minutes.

## 1. Open a terminal

You'll paste a few commands into your computer's terminal. Here's how to open it:

| System | How to open Terminal |
|--------|---------------------|
| **Mac** | Press **Cmd + Space**, type **Terminal**, hit **Enter** |
| **Windows** | Press **Win + R**, type **wt** (or **cmd**), hit **Enter** |
| **Linux** | Press **Ctrl + Alt + T** |

You should see a window with a blinking cursor. That's where you'll paste the commands below.

## 2. Run the bootstrap script

Copy this entire block and paste it into your terminal (then hit Enter):

```bash
curl -fsSL https://raw.githubusercontent.com/gocon-loca/dreamteam-ai/main/scripts/bootstrap.sh | bash
```

This single command installs everything you need:
- Node.js 22, pnpm, Git, Claude Code CLI
- Downloads DreamTeam
- Installs all dependencies
- Offers to launch the setup wizard when done

Just follow any prompts that appear. If it asks for your password, that's your computer's login password (you won't see characters as you type — that's normal).

> **Got an error?** Copy the error text, paste it into ChatGPT or Claude, and say "I'm setting up DreamTeam and got this error." AI is great at debugging install issues.

## 3. Run the setup wizard

If the bootstrap script didn't launch it automatically, run:

```bash
cd ~/dreamteam-ai
pnpm run setup:web
```

The wizard opens in your browser and walks you through configuring your AI provider (Anthropic API key or Claude Pro/Max subscription), registering your projects, and optionally setting up Telegram.

## 3. Build

```bash
pnpm build
```

## 4. Add your first goal

No Telegram required — use the CLI:

```bash
pnpm goal add my-project "Fix the login button"   # create a goal
pnpm goal list                                     # list goals by status
pnpm goal status                                   # system overview
```

Start the autonomous agent loop:

```bash
bash scripts/start.sh
```

## 5. Telegram (optional)

Control DreamTeam from your phone:

1. Message `@BotFather` on Telegram → `/newbot` → save the bot token
2. Message `@userinfobot` → save your user ID
3. Enter both when the setup wizard asks

Key commands: `/goal my-project Fix the button`, `/goals`, `/startwork`, `/status`

## What to expect

After starting, the supervisor picks up your goal, creates a `goal/{id}` branch in your project, and runs Claude Code autonomously. Quality gates (code review + optional smoke tests) run on completion. On pass, the branch merges to main.

Goals typically complete in 2–15 minutes.

## Project configuration

In `config/projects.yaml`:

```yaml
projects:
  my-app:
    path: ~/code/my-app
    description: "My web app"
    hasDevServer: true
    devCommand: "npm run dev"
    devPort: 3000
    healthCheck: "http://localhost:3000"
```

Add a `CLAUDE.md` to each project root — agents read it first to learn your stack and conventions.

## Further reading

- [docs/SETUP.md](SETUP.md) — detailed setup with troubleshooting
- [docs/COSTS.md](COSTS.md) — understanding and controlling spend
- [CLAUDE.md](../CLAUDE.md) — full system architecture
