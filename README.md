# TPBC Lights

The lighting controller for Turning Point Miami, replacing Lightkey. It listens for the
same OSC messages Lightkey did (FreeShow slide triggers on port 21600, Companion's Lightkey
buttons), runs the cues, and sends Art-Net to the Chauvet DMX-AN. All looks are YAML text
files, so changes are made by asking Claude (see `CLAUDE.md`).

Plan and decisions: the "TPBC Lighting Controller — Lightkey Replacement Plan" doc in the
TPBC Production project.

## What's in it

- 26 fixtures patched from the Lightkey export (one universe).
- 157 song cues (12 Sunday folders, 12 Youth folders) and 13 panel looks, converted from
  Lightkey. Every address FreeShow or Companion uses today still works (`npm run check`
  proves it).
- Fades, latest-takes-precedence layering, GO/BACK, master/blackout, Floor Random.
- Automatic dark-change for colour-wheel moves of more than one slot.
- Relative position effects (wiper, pan track, tilt wave, triangle, circle).
- Service lock: show reloads are refused during service times unless forced.
- Shadow mode: runs and logs everything without sending Art-Net, for running alongside
  Lightkey.

## Commands

```
npm start                 run the service (OSC :21600, HTTP :8080)
npm run check             validate the show (run after every edit)
npm test                  engine tests
npm run render -- <addr>  show the finished look + DMX for a cue, offline
npm run send -- <addr> [fade] [--host ip]   send one OSC message (like FreeShow)
npm run monitor           print Art-Net channels as they change
npm run reload            check, then hot-reload the running service
npm run addresses         list every OSC address the show answers
```

Node 22.18 or newer runs the TypeScript directly; there is no build step.

## Install on the Pi (10.1.20.23)

```
git clone https://github.com/TPBCHostingServices/tpbc-lights.git
cd tpbc-lights && bash deploy/install-pi.sh
```

Then install Claude Code on the Pi and sign in, so changes can be made right there.

## Restarts and the HTTP API

- The running look is saved to `state/last-look.json` and restored on start (if saved within
  `state.restore_max_age_minutes`, default 6 h), so a restart or crash mid-service does not
  black out the stage. Set it to 0 to start dark.
- HTTP POSTs (`/api/fire`, `/api/output`, `/api/reload`) work from the Pi itself. From other
  machines they need `TPBC_HTTP_TOKEN` (or `http.token`) sent as `x-token` or
  `Authorization: Bearer`. GETs stay open. `http.bind: 127.0.0.1` closes the port to the VLAN.
  FreeShow and Companion use OSC, which is unaffected.

## Gate A: bench checks before it touches a service

Do these on a weeknight with Lightkey's output off (or the DMX-AN unplugged from Lightkey):

1. **Universe:** set `artnet.enabled: true`, restart, fire FULL WHITE
   (`npm run send -- /live/Control_Panel/cue/FULL_WHITE/activate`). If nothing lights,
   change `artnet.universe` from 0 to 1.
2. **U'King P6/P7:** fire a coloured cue; if P6/P7 flash or run a program, fix the fixed
   values in `rig/fixtures/uking-zq01047-7ch.yaml`.
3. **Upper Wash aim:** fire any song chorus; if the spots don't land where Lightkey put
   them, adjust `calibration` in `rig/patch.yaml`.
4. **Gobos:** fire START (Moons gobo) and fill in the gobo slot numbers in the
   Intimidator profile.
5. **Fades on panel looks:** Lightkey stored 0.5 s and 3 s for PRE_POST/START/VIDEO/SERMON;
   0.5 s is used. Compare with what you're used to.
6. Read `import/conversion-report.md` and check the listed cues on stage.

## Cutover

1. Lightkey: turn its Art-Net output off.
2. Pi: `artnet.enabled: true` in `config/config.yaml`, then `sudo systemctl restart tpbc-lights`.
3. FreeShow: change the "LightKey OSC" emitter host from 10.1.20.16 to 10.1.20.23.
4. Companion: change the Lightkey connection host from 10.1.20.16 to 10.1.20.23.
5. Fallback: reverse steps 3-4 and turn Lightkey's output back on.

## Layout

```
config/config.yaml   network, Art-Net, service lock
rig/                 patch and fixture profiles
presets/ effects/    named colours, aims, movement shapes
panels/ songs/       the looks
pages.yaml           GO/BACK order
sequences.yaml       Floor Random
src/                 engine, OSC, Art-Net, server
tools/               check, render, send, monitor, reload, converter
tests/               engine tests
import/              Lightkey export + conversion report
deploy/              systemd unit + Pi installer
```
