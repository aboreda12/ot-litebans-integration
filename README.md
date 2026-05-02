# LiteBans Integration — Open Ticket Plugin

**Author:** Youssef  
**Version:** 1.0.0  
**Supported:** OTv4.0.x · OTv4.1.x · OTv4.2.x  
**Dependency:** `mysql2` , `Litebans` (Minecraft plugin)

---

## What It Does

This plugin bridges your **LiteBans MySQL database** with your **Open Ticket Discord bot**. It gives staff slash commands to manage in-game punishments directly from Discord, and can automatically post a player's punishment history inside a ticket the moment it's opened.

---

## Features

### Slash Commands

All commands are Discord slash commands registered globally to your server.

#### Punishment Commands

| Command | Description |
|---|---|
| `/gameban <player> <reason> <duration>` | Bans a Minecraft player. Duration examples: `7d`, `2h`, `30m`, `perm` |
| `/gameunban <player> [reason]` | Removes all active bans for a player |
| `/gamemute <player> <reason> <duration>` | Mutes a player (chat-silenced in-game) |
| `/gameunmute <player> [reason]` | Removes all active mutes for a player |
| `/gamewarn <player> <reason>` | Issues a warning to a player |
| `/gameunwarn <player> [reason]` | Removes the most recent active warning for a player |

All punishment commands support an optional `silent` boolean flag. When set to `true`, LiteBans will not broadcast the action publicly in-game.

#### Lookup Commands

| Command | Description |
|---|---|
| `/history <player>` | Shows full punishment history (bans, mutes, warnings, kicks) |
| `/checkban <player>` | Checks if a player currently has an active ban |
| `/checkmute <player>` | Checks if a player currently has an active mute |
| `/checkalts <player>` | Finds alt accounts linked via shared IP history |

### Auto Punishment History on Ticket Open

When a ticket is opened using a trigger option, the plugin automatically reads the **first question's answer** as a Minecraft username and posts that player's full punishment history in the ticket channel.

### Action Logging

Every punishment action is sent as an embed to a configured log channel, so your team always has an audit trail.

---

## Installation

1. Drop the `litebans-integration` folder into your Open Ticket `plugins/` directory.
2. Edit `plugins/litebans-integration/config.json` (see Configuration below).
3. Restart your bot.

---

## Configuration (`config.json`)

```json
{
    "mysql": {
        "host":     "YOUR_DB_HOST",
        "port":     3306,
        "user":     "YOUR_DB_USER",
        "password": "YOUR_DB_PASSWORD",
        "database": "YOUR_LITEBANS_DB"
    },
    "tablePrefix": "litebans_",
    "roles": {
        "ban":    ["ROLE_ID_HERE"],
        "mute":   ["ROLE_ID_HERE"],
        "warn":   ["ROLE_ID_HERE"],
        "lookup": ["ROLE_ID_HERE"]
    },
    "logChannelId": "CHANNEL_ID_HERE",
    "ticketHistoryTriggers": [
        "your-ticket-option-id"
    ],
    "historyEmbed": {
        "color":             "#e74c3c",
        "maxEntriesPerType": 5
    }
}
```

**Field reference:**

- `mysql` — Connection details for your LiteBans MySQL database.
- `tablePrefix` — Table prefix used by LiteBans. Default is `litebans_`. Change this only if you customized it in LiteBans.
- `roles` — Discord Role IDs allowed to use each command group. A user only needs **one** of the listed roles. An empty array `[]` means nobody can use those commands.
  - `ban` controls `/gameban` and `/gameunban`
  - `mute` controls `/gamemute` and `/gameunmute`
  - `warn` controls `/gamewarn` and `/gameunwarn`
  - `lookup` controls `/history`, `/checkalts`, `/checkban`, `/checkmute`
- `logChannelId` — Channel ID where all punishment actions are logged. Set to `""` to disable.
- `ticketHistoryTriggers` — See the dedicated section below.
- `historyEmbed.color` — Hex color for punishment history embeds.
- `historyEmbed.maxEntriesPerType` — Maximum number of bans/mutes/warns/kicks shown per category in history embeds.

---

## Setting Up Auto Punishment History in Tickets

This is the feature that automatically posts a player's punishment history when a ticket is opened.

**How it works:** When a ticket is created, the plugin checks if the ticket's **option ID** is in `ticketHistoryTriggers`. If it is, it reads the player's name from the **first question's answer** in that ticket and fetches their LiteBans history.

### Step-by-step

1. Open your Open Ticket `config/options.json` file.
2. Find the ticket option you want to trigger on (e.g. a "Ban Appeal" or "Report Player" type).
3. Copy its `id` field — it looks something like `"ban-appeal"` or `"report-player"`.
4. Paste that ID into the `ticketHistoryTriggers` array in `config.json`:

```json
"ticketHistoryTriggers": [
    "ban-appeal",
    "report-player"
]
```

5. Make sure the **first question** (`questions[0]`) in that ticket option asks for a **Minecraft username**. The plugin always reads `answers[0]` as the player name.

You can add as many option IDs as you want. If the array is empty, the auto-history feature is disabled entirely.

> **Tip:** The option ID is case-sensitive and must match exactly. If you're unsure what an option's ID is, open `config/options.json` and look for the `"id"` field on each option object.

---

## UUID Resolution

The plugin resolves Minecraft usernames to UUIDs in two steps:

1. First checks your LiteBans `history` table for a known UUID matching the name.
2. If not found locally, queries the **Mojang API** (`api.mojang.com`) as a fallback.

The player must have either joined your server at least once **or** have a valid Mojang account for punishment commands to work.

---

## How It Connects to LiteBans

This plugin writes **directly to your LiteBans MySQL tables** — it does not use RCON or any Minecraft server connection. Punishments are inserted with `server_origin = 'Discord'` so they are clearly identified in LiteBans logs. Active bans and mutes are deactivated by setting `active = 0` with the Discord user's name recorded as `removed_by_name`.

> **Note:** Because the plugin writes directly to the database, LiteBans broadcast messages or BungeeCord synchronization may not fire instantly. The punishment will be enforced on the next login or when LiteBans refreshes its cache.

---

## Troubleshooting

| Problem | Check |
|---|---|
| MySQL not connected on startup | Verify `host`, `port`, `user`, `password`, `database` in config.json. Ensure your bot host can reach the database. |
| Commands not appearing in Discord | Slash commands register on startup. Wait a few minutes for Discord to propagate them globally, or restart the bot. |
| "UUID not found" on punishment commands | The player has never joined your server and isn't found on Mojang's API (e.g. cracked username). |
| History not posting in tickets | Check that the option `id` in `ticketHistoryTriggers` exactly matches the `id` in your `options.json`. It is case-sensitive. |
| "No answers in ticket" warning | The ticket's first question was left blank by the user, or no questions are configured on that option. |
| Commands give "No roles configured" error | The relevant role array in `config.json` is empty (`[]`). Add at least one Role ID. |

