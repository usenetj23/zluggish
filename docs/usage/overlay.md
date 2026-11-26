---
sidebar_position: 6
description: Live widget windows for a second screen or a stream, compatible with Sauce for Zwift.
---

# Overlay

The Overlay is a set of live widget pages that you open in their own browser windows while you ride: on a second
screen, on a tablet, or as a browser source of your streaming app. The pages are the widget pages of
[Sauce for Zwift](https://github.com/SauceLLC/sauce4zwift), served by Zluggish from its own world, so nothing connects to the Zwift
servers and Sauce does not have to run.

The Overlay is off for every user until they turn it on.

## Turn it on

1. Open the web app and select **Overlay** in the menu.
2. Select **Enable Overlay**.
3. Under **Windows to open**, select **Open** next to a window. Select **Settings** to change what the window shows.

The windows need a signed-in browser. A window opened in another browser, or after you sign out, goes to the sign-in
page instead.

## Windows

| Window                                         | Shows                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| Overview                                       | A bar with your own ride: ride ons, energy and more.                      |
| Nearby Athletes                                | The riders around you on the road, as a table you choose the columns of.  |
| Groups                                         | The packs riding together. Select your pack to see the riders around you. |
| Watching                                       | Data fields of your own ride, on screens you arrange.                     |
| Chat                                           | The chat of the game, including your direct messages.                     |
| Power, Heart Rate, Cadence, Pace, W'bal, Draft | A gauge each.                                                             |

Every window has a theme, a background texture and a font in its settings. The settings are kept in the browser,
so each browser keeps its own.

## Mods

Mods written for Sauce for Zwift can add windows of their own. An administrator installs and enables them, see
[Mods](mods.md).

## Limits

- The windows only show data. Sending chat, giving Ride Ons and watching another rider are not part of the Overlay
  yet.
- The Watching line chart stays empty: the server keeps no per-second history of a ride yet.
- Normalized Power, Load and Intensity are calculated by Zluggish. They are the names Intervals.icu uses for the
  values Sauce calls NP, TSS and IF.
