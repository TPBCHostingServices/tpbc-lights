# TPBC Lights: rules for Claude

This repo runs the live stage lights at Turning Point Miami (a church). Spencer changes
it by asking Claude in plain English ("make the Wonder chorus warmer", "add Youth cues for
Firm Foundation"). A mistake shows up in front of a congregation and on the livestream,
so follow these rules every time.

## What lives where

| Path | What it is | Change it when |
|---|---|---|
| `songs/sunday/*.yaml`, `songs/youth/*.yaml` | One file per song: its cues (looks) | Almost every request |
| `panels/*.yaml` | Panel looks on Companion pages 8/13 (PRE_POST, START, VIDEO, SERMON, HOUSE, FULL WHITE) | Changing a service look |
| `presets/colors.yaml`, `presets/positions.yaml` | Named colours and moving-head aims | New colour names / aims |
| `effects/library.yaml` | Moving-head movement shapes | New or retuned movement |
| `sequences.yaml` | Floor Random | Rarely |
| `pages.yaml` | Song order for GO / BACK | New song added |
| `rig/patch.yaml`, `rig/fixtures/*.yaml` | Fixtures, DMX addresses, channel layouts, calibration | New light bought, re-addressed |
| `config/config.yaml` | Network, Art-Net on/off, service lock times | Rarely; ask first |
| `src/` | The engine (TypeScript, run directly by Node 22.18+, no build) | Only for new features or bugs |
| `import/` | Original Lightkey export and conversion report | Never edit; history only |

## The address rule (never break it)

FreeShow slides and Companion buttons fire cues by OSC address, built from names:

- Song cue: `/live/<page>/<folder>/<CUE>/activate`, e.g. `/live/Youth/Wonder/CHORUS/activate`
- Panel look: `/live/<page>/cue/<NAME>/activate|toggle`, e.g. `/live/Control_Panel/cue/HOUSE_100%/toggle`

So **never rename** a song's `page` or `folder`, a cue name, or a panel button name: that
silently breaks the FreeShow trigger or Companion button that points at it. `npm run check`
fails if any address FreeShow or Companion sent to Lightkey no longer resolves.

New songs: `folder` = song title with underscores, no apostrophes, ampersands or accents
(`Goodness_Of_God`). Cue names: INTRO, VERSE, PRE_CHORUS, CHORUS, CHORUS_2..., BRIDGE,
BRIDGE_2, TAG, OUTRO. Sunday songs use `page: Control_Panel`; Youth songs `page: Youth`.
Add the folder to `pages.yaml`. Give Spencer the new addresses (`npm run addresses -- Youth`)
so he can add the FreeShow emitter templates; enter them in FreeShow without the leading `/`.

## Writing a cue

```yaml
  CHORUS:
    fade: 1.5                     # seconds
    PAR:  { color: [80, 90, 100], level: 85 }     # PARs P1-P7 (RGB %)
    BARS: { color: cyan, level: 85 }              # wall-wash bars B1-B7
    MH:   { color: white, level: 70, position: upper_wash, effect: { type: wiper, period: 8 } }
    HOUSE: { level: 0 }           # tent house lights 200-207, always one level
    P1:   { color: pink }         # a single fixture overrides its group line
```

- `color`: a name from `presets/colors.yaml` or `[r, g, b]` in percent. On the moving heads
  it means a colour-wheel slot (white, yellow, magenta, green, red, cyan, orange, blue,
  light_green, amber); an RGB value picks the nearest slot.
- `position`: a name from `presets/positions.yaml` (`upper_wash` is the crowd aim) or
  `{ pan: 270, tilt: 98.9 }` in Lightkey degrees.
- `effect`: moves around the cue's position (relative). Every Youth cue with movement
  should also set `position: upper_wash`.
- A group or fixture not mentioned keeps its colour/position but its **level goes to 0**.
- `extends: Folder/CUE` copies another cue in the same file, then your lines override it.

## House style (from Spencer)

- Shape: INTRO/OUTRO dim (PAR ~20, BARS ~25-30, spots off), VERSE low (35/45, spots 15-20),
  PRE_CHORUS building, CHORUS bright (80-85), later choruses up to 100, BRIDGE slow builds
  (6-12 s fades), TAG a hit or pull-back.
- Fades: verses 3-4 s, choruses 1.5-3 s, bridges 6-12 s, outros 4-6 s.
- Sunday: calm, little movement, keep the spot colour steady through a song (change looks
  with PARs/bars/levels). Youth: more saturation, faster fades, spot movement.
- Colours follow the song's FreeShow background (waterfall = blues/icy white, golden light
  = amber/gold, ocean/lighthouse = sea-blue with amber beams, and so on).
- HOUSE stays 0 in every song cue.
- Colour-wheel moves of more than one slot get an automatic dark-change (dim, move, fade
  up). That is built into the engine; don't hand-build sequences for it.

## Every change, in this order

1. Edit the YAML (or code).
2. `npm run check`: must say OK. Fix every error before anything else.
3. For code changes also `npm test` and `npm run typecheck`.
4. Show Spencer what changed: `npm run render -- /live/Youth/Wonder/CHORUS/activate`
   prints the finished look and DMX per fixture. Summarise in plain words.
5. Commit with a plain message ("Youth: add Firm_Foundation, 6 cues") and push.
6. On the Pi only: `npm run reload` puts it live without dropping the current look. During
   a service-lock window (Sun 8:00-13:30, Wed 18:30-21:30, Fri 18:00-22:30) it refuses;
   only use `npm run reload -- --force` if Spencer explicitly says to. **Never** restart
   the service (`systemctl restart tpbc-lights`) during a service window, and never change
   `config/config.yaml`, turn Art-Net output on or off, or change the patch without asking.

## Facts worth knowing

- Lights: 5 Chauvet SlimPAR 56 (P1-P5), 2 U'King PARs (P6, P7), 6 Chauvet COLORrail IRC +
  1 Rockville RockStrip 252 (bars B1-B7), 4 Chauvet Intimidator Spot LED 150 (MH1-MH4).
  Art-Net universe 1 through a Chauvet DMX-AN at 10.1.20.11. This Pi: 10.1.20.23.
- The Intimidator's "blackout while moving" commands don't work on these units, which is
  why the engine does the dark-change itself.
- Things still to verify on the real rig are marked `VERIFY` in the files (U'King channel
  values, gobo slots, pan/tilt calibration, Art-Net universe number).
- HTTP API on :8080: `GET /api/status` (what's live, unmatched addresses), `GET /api/look`,
  `POST /api/fire {"address": "/live/..."}`, `POST /api/reload`.
