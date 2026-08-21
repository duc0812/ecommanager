# Codex access to the VPS

The preferred setup is an SSH remote connection from Codex Desktop. This lets Codex work against the VPS filesystem and shell while preserving interactive approvals. Do not expose a Codex app-server or a generic shell endpoint through the Ecom Manager website.

## 1. Install and authenticate Codex on the VPS

From an SSH session in the repository:

```bash
bash scripts/codex-vps-setup.sh --install
codex login --device-auth
codex login status
```

Device authentication opens a URL and gives you a one-time code. Enable device-code login in ChatGPT security settings or ask the workspace admin to enable it if the option is unavailable.

For usage-based API authentication instead:

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

Never save the key in the repository, paste `~/.codex/auth.json` into chat, or expose it through an application API.

## 2. Add the VPS to local SSH configuration

On the computer running Codex Desktop, add a concrete alias to `~/.ssh/config`:

```sshconfig
Host ecom-vps
  HostName YOUR_VPS_HOST_OR_IP
  User YOUR_DEPLOY_USER
  IdentityFile ~/.ssh/id_ed25519
```

Verify the connection locally:

```bash
ssh ecom-vps
```

The SSH user should be a least-privilege deploy user with read/write access only to the application and its required runtime directories.

## 3. Connect Codex Desktop

1. Open **Settings > Connections**.
2. Add or enable the `ecom-vps` SSH host.
3. Choose the repository folder on the VPS.
4. Start a task in that remote project and ask Codex to review or fix code.

Codex Desktop starts the remote Codex app server through SSH. The `codex` command must therefore be on the remote user's login-shell `PATH`.

Do not expose the app-server WebSocket port publicly. Use SSH, VPN, or a private mesh network.

## 4. Optional direct CLI tasks

Review without changing files:

```bash
bash scripts/codex-vps-task.sh review "Review the payout sync and report correctness or security issues"
```

Apply a scoped fix inside the repository:

```bash
bash scripts/codex-vps-task.sh fix "Reproduce the mapping issue, implement the smallest safe fix, and run relevant tests"
```

The wrapper uses a read-only sandbox for reviews and `workspace-write` for fixes. It never enables `danger-full-access` and tells Codex not to commit, push, deploy, restart services, modify `.env`, or touch the runtime database.

## 5. VPS deployment requirements

- Keep the repository in a stable absolute path.
- Use an absolute `DATABASE_URL` outside rotating release directories.
- Run one shared SQLite database file for every application process.
- Keep Git, Node.js, npm, and Codex CLI available in the SSH user's login shell.
- Back up the database before separately authorized schema or deployment work.

Official references:

- https://learn.chatgpt.com/docs/remote-connections
- https://learn.chatgpt.com/docs/auth
- https://learn.chatgpt.com/docs/non-interactive-mode
