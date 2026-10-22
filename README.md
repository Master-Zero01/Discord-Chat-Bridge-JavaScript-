# Discord Chat Bridge (JavaScript)

## Features

- Relay between server text/announcement channels, including across servers where the bot is installed.
- Configure one-way routes or a bidirectional pair.
- Persist routes in `data/bridges.json`; routes resume after restarts.
- Use a dedicated webhook per target channel when the bot has **Manage Webhooks**, preserving the sender's display name and avatar. Otherwise, messages are posted as the bot with the sender's name prefixed.
- Relay message text, embeds, and attachment links.
- Mirror edits/deletions while message-to-mirror records remain in memory. These records do not survive restarts.
- Prevent feedback loops, avoid forwarding command messages, and disable mention pings.
- Require Manage Server permission in both servers for cross-server bridge management unless a trusted operator is allowlisted.
- No database or web server required.

## Requirements

- Node.js **22.12.0 or newer**.
- A Discord bot token.
- The bot must be in every server containing source/target channels.

## Install (Windows PowerShell)

1. Download and extract the ZIP (or clone the GitHub repository).
2. Open a terminal in the project directory:

   ```powershell
   npm install
   Copy-Item .env.example .env
   ```

3. Edit `.env` and set `DISCORD_TOKEN` to the token from the Discord Developer Portal. Never share or commit this value.
4. In the Discord Developer Portal, open your application → **Bot** → **Privileged Gateway Intents**, and enable **Message Content Intent**.
5. Invite the bot to all participating servers using the `bot` scope and permissions below.
6. Start the bot:

   ```powershell
   npm start
   ```

On Linux/macOS use `cp .env.example .env` in place of `Copy-Item`.

## Permissions

The bot needs:

- **View Channels** and **Read Message History** in source channels.
- **View Channels** and **Send Messages** in target channels.
- **Manage Webhooks** in target channels to preserve the sender's name/avatar. Without it, the bot falls back to regular bot-authored messages.

Avoid granting Administrator unless you have a separate reason to do so.

## Commands

Default command prefix: `?` (change with `COMMAND_PREFIX` in `.env`).

| Command | Function |
|---|---|
| `?relay help` | Show help |
| `?relay add <source-id> <target-id>` | Add a one-way route |
| `?relay <source-id> <target-id>` | Shorthand compatible with the original repository |
| `?relay bidirectional <channel-a-id> <channel-b-id>` | Forward both directions |
| `?relay list` | List configured routes |
| `?relay remove <source-id> <target-id>` | Remove one route |
| `?relay stop [channel-id]` | Remove every route involving a channel; defaults to the current channel |

Enable Discord Developer Mode under **User Settings → Advanced**, then right-click a channel and choose **Copy Channel ID**.

For cross-server safety, the user configuring/removing a route must have **Manage Server** permission in every server involved. Trusted global bot operators can be exempted by setting `BRIDGE_OWNER_IDS` to a comma-separated list of Discord user IDs in `.env`. Only list trusted administrators.

## How it works

`?relay add A B` routes messages from A to B. `?relay bidirectional A B` creates the two routes A → B and B → A. The bot ignores bot/webhook-authored messages to prevent relay loops. Messages whose text starts with the configured prefix are not relayed.

Configuration is stored automatically in `data/bridges.json`. Back up this file if you want to preserve routing settings. Do not manually edit it while the process is running; restart the bot after manual changes.

## Limits and caveats

- Attachments are forwarded as links, not downloaded/re-uploaded. Access to the attachment can depend on the original URL.
- Discord text content is limited to 2,000 characters, so long text/attachment lists are split into multiple messages.
- Edits and deletes mirror only while the related mapping remains in memory. After a bot restart, routes still work but older relayed messages can no longer be edited/deleted by the bridge.
- Message Content Intent is required because this bot uses prefix commands and reads normal message text. Enable it both in code and in the Developer Portal.
- API and permission errors are written to the terminal. If a route is not relaying, confirm the bot is present in both servers and its channel permissions are correct.

## Tests

Run the offline tests without a bot token:

```bash
npm test
npm run check
```

The test suite uses Node's built-in runner and does not make a live Discord connection.

## Security

- Never commit `.env` or expose your bot token. If exposed, reset it immediately in the Developer Portal.
- Keep `BRIDGE_OWNER_IDS` empty unless you need designated global operators.
- Forwarded mentions are rendered as text and mention parsing is disabled to avoid accidental pings.
