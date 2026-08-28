# Seek in Figma

Every screen of the app, built from the same numbers the app renders from, so
the Figma file can be tweaked and the result means something.

## Why this exists rather than the Figma MCP server

Figma's hosted MCP server meters tool calls: **20 a month on the Starter plan**,
which is about two screens. The Plugin API has no meter, because it runs inside
the desktop app rather than on Figma's infrastructure. So the loop moves local.

```
  agent  --curl-->  bridge.mjs  --long poll-->  plugin  -->  Figma document
  agent  <--PNG---  bridge.mjs  <---result----  plugin
```

Nothing leaves the machine. The bridge binds loopback only, and the plugin's
manifest asks for `http://localhost:8787` through `devAllowedDomains`, which is
Figma's own mechanism for a local dev server.

The PNG path is the point of the whole thing: the agent can look at what it
built instead of asking a human to describe it.

## Setup, once

```bash
node design/bridge.mjs        # leave it running
```

Then in **Figma desktop** (plugin development needs the app, not the browser):

1. Plugins → Development → **Import plugin from manifest…**
2. Pick `design/figma-plugin/manifest.json`
3. Open the Seek design file → Plugins → Development → **Seek design sync**

The panel goes green when it finds the bridge. Leave it open — it is the channel.

## Driving it

```bash
curl -s localhost:8787/health
curl -s -XPOST localhost:8787/job -d '{"cmd":"ping"}'
curl -s -XPOST localhost:8787/job -d '{"cmd":"build","screens":["downloads"]}'
curl -s -XPOST localhost:8787/job -d '{"cmd":"build"}'                 # everything
curl -s -XPOST localhost:8787/job -d '{"cmd":"shoot","scale":1}'       # re-render only
```

`POST /job` blocks until the plugin answers, so one request is one round trip
including the error if it threw. Renders land in `design/shots/`.

## Asking for changes

Three channels, in order of how well they work.

**1. Just say it, in chat.** Fastest by a distance. "Labels should use a tag
icon", "the download rows are too tall", "Failed should be a list not a grid".
It goes into `code.js`, which means the change is reproducible and survives
every future rebuild.

**2. Comment in Figma**, pinned to the screen or element in question.

```bash
node design/comments.mjs          # open threads, grouped by screen
node design/comments.mjs --all    # resolved ones too
```

The Plugin API cannot see comments — they exist only in the REST API, which is
a separate door needing a personal access token (free plan, per-minute limits,
nothing to do with the MCP quota). Set one up once:

```bash
mkdir -p ~/.config/seek && printf '%s' 'figd_...' > ~/.config/seek/figma-token && chmod 600 ~/.config/seek/figma-token
```

Never put that token in this repo.

**3. Edit it in Figma yourself.** Fine for trying something out, but understand
what it is: a change that lives only in the Figma file. The app does not have
it, and the builder does not know about it. Tell me what you liked and it
becomes real.

A rebuild would normally replace a screen wholesale, so **`build` refuses to
overwrite a screen you have edited by hand** — it fingerprints node count, text
length and vector path length when it builds, checks that before replacing, and
skips with `keptByHand` if they differ. Send `"force": true` once the change has
been folded into `code.js`.

The **Notes** and **Foundations** pages are never touched by a build.

## Changing an icon

Sidebar icons are the second field of each row in `NAV`. Any of Lucide's ~1500
icons can be pulled in:

```bash
node design/add-icon.mjs tag bookmark radio
```

It reads geometry from the copy of Lucide already in `app/node_modules`, follows
deprecated aliases (`alert-triangle` → `triangle-alert`), and suggests near
matches for a name that does not exist. Then re-run the plugin.

## The two loops

| you changed | what to do |
| --- | --- |
| a **job** — which screens, which options | nothing; just send it |
| **`code.js`** — the builders themselves | re-run the plugin in Figma (⌥⌘P), Figma reloads it from disk |

## Where the numbers come from

| in here | in the app |
| --- | --- |
| `RAMP` | `app/src/styles/tokens.css`, the `prefers-color-scheme: dark` block |
| `SP`, `RAD`, `TYPE` | the `--sp-*`, `--radius-*`, `--fs-*` tokens |
| `ICONS` | Lucide geometry, as used by `app/src/icons/index.tsx` |
| `PAINTED = 1.6` | `PAINTED_STROKE`, with the same `painted × 24 / size` inversion |
| `NAV` | the `groups` array in `app/src/ui/Sidebar.tsx` |
| `WIN`, `SIDEBAR_W` | `tauri.conf.json`, `--sidebar-w` |

When the app's tokens change, those constants are what has to change with them.

## Conventions in the file

- **Screens** page holds one frame per screen, laid out on a grid by `ORDER`.
  The `Sidebar` component is parked to the left of the grid, deliberately clear
  of it — a master sitting on top of a screen reads as a stray layer and gets
  deleted by accident.
- **Foundations** holds the colour variables and their swatches.
- **Notes** holds `note:visual` / `note:technical` cards. The Plugin API has no
  comment surface and Starter has no Dev Mode annotations, so notes are nodes:
  writable by hand, readable back by the agent.
- Starter allows **3 pages and 1 variable mode**, which is why there is no
  separate Components page and no light mode.
