# zoho-sprints-mcp

Connect **Zoho Sprints** to **Claude Code**, **Claude Desktop** and **OpenAI Codex**.
Then just ask: *"create a backlog task called Fix login bug"*.

## Tools

| Tool | What it does |
| --- | --- |
| `list_projects` | List projects |
| `list_sprints` | List sprints and the backlog |
| `list_item_meta` | List item types, priorities, statuses |
| `list_items` | List work items |
| `list_users` | List users (for assigning) |
| `create_item` | Create an item |
| `move_items` | Move items between sprints / backlog |
| `zoho_request` | Call any other Zoho Sprints API |

---

## Setup

You need **Node.js 20.12+**.

### Step 1: Install

```bash
git clone https://github.com/shiva-srivastav/zoho-sprints-mcp.git
cd zoho-sprints-mcp
npm install
npm run hooks
cp .env.example .env
```

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

### Step 2: Create a Zoho client

1. Open the API console for your region:
   - `sprints.zoho.com` → <https://api-console.zoho.com>
   - `sprints.zoho.in` → <https://api-console.zoho.in>
   - `sprints.zoho.eu` → <https://api-console.zoho.eu>
2. Click **ADD CLIENT** → **Self Client** → **CREATE NOW**.
3. In `.env`, fill in:

   ```
   ZOHO_TLD=in              # com, in, eu ... (from your Sprints URL)
   ZOHO_CLIENT_ID=...
   ZOHO_CLIENT_SECRET=...
   ```

### Step 3: Get a refresh token

1. On the same client, open the **Generate Code** tab.
2. Paste this into **Scope**:

   ```
   ZohoSprints.projects.READ,ZohoSprints.sprints.READ,ZohoSprints.items.READ,ZohoSprints.items.CREATE,ZohoSprints.items.UPDATE
   ```

3. Set **Time duration** to 10 minutes, then click **CREATE** and copy the code.
4. Run this within 10 minutes:

   ```bash
   npm run auth -- --code PASTE_CODE_HERE
   ```

This saves `ZOHO_REFRESH_TOKEN` into `.env`.

### Step 4: Fill in your IDs

```bash
npm run selftest -- --live
```

Copy these values from the output into `.env`:

```
ZOHO_TEAM_ID=                # Sprints > Settings > Workspace
ZOHO_PROJECT_ID=             # from list_projects (long number)
ZOHO_DEFAULT_ITEM_TYPE_ID=   # from list_item_meta > itemTypes
ZOHO_DEFAULT_PRIORITY_ID=    # from list_item_meta > priorities
ZOHO_BACKLOG_ID=             # from list_sprints > backlogId
```

Run `npm run selftest -- --live` again. Every tool should show `[OK]`.

### Step 5: Connect your AI app

Print the exact commands for your machine:

```bash
npm run client-config
```

In the examples below, replace `/ABS/PATH` with your project folder, for
example `C:/Users/you/zoho-sprints-mcp`.

#### Claude Code

```bash
claude mcp add zoho-sprints --scope user -- node /ABS/PATH/src/index.js
```

Check it with `claude mcp list`. It should show `✔ Connected`.

#### Claude Desktop

1. Go to **Settings** → **Developer** → **Edit Config**.
2. Add the server:

   ```json
   {
     "mcpServers": {
       "zoho-sprints": {
         "command": "node",
         "args": ["/ABS/PATH/src/index.js"]
       }
     }
   }
   ```

3. Fully quit Claude Desktop and reopen it.

#### OpenAI Codex

```bash
codex mcp add zoho-sprints -- node /ABS/PATH/src/index.js
```

Or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.zoho-sprints]
command = "node"
args = ['/ABS/PATH/src/index.js']
startup_timeout_sec = 20
```

Check it with `codex mcp list`.

### Done

Ask your AI:

- *"List my Zoho sprints"*
- *"Create a backlog task called Write onboarding guide"*
- *"Move item 123 to the backlog"*

---

## Commands

| Command | Use |
| --- | --- |
| `npm run auth -- --code CODE` | Save refresh token |
| `npm run selftest -- --live` | Test all tools |
| `npm run client-config` | Show setup commands for Claude / Codex |
| `npm run check-secrets` | Check nothing private will be committed |
| `npm run batch -- --sprint ID "A" "B"` | Create many items at once |

## Problems?

| Error | Fix |
| --- | --- |
| `invalid_code` | The code expired. Generate a new one (Step 3). |
| `invalid_client` | `ZOHO_TLD` doesn't match the console you used. |
| `invalid_grant` | Token revoked. Redo Step 3. |
| `Access Denied` | Too many requests. Wait a few minutes. |
| `team_id is required` | Fill in `ZOHO_TEAM_ID` / `ZOHO_PROJECT_ID` in `.env`. |
| Not connected | Run `node /ABS/PATH/src/index.js`. It should print `ready`. |
| Claude Desktop shows no tools | Fully quit and reopen it. |

## License

[MIT](LICENSE). Free to use, modify and share.
