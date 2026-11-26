---
sidebar_position: 7
description: Run Sauce for Zwift mods in the Overlay, and what an administrator should know before enabling one.
---

# Mods

Sauce for Zwift has mods: a folder with a `manifest.json`, some web pages (windows) and optionally scripts and styles
that run in every window. The [Overlay](overlay.md) runs the same mods, so mods written for Sauce work unchanged as
long as they use what the Overlay offers.

## Install and enable a mod

You need the administrator role.

1. Open the web app, select **Overlay** and then **Mods**.
2. Install the mod in one of three ways:
   - **Mod store**: select **Browse the store** and **Install** next to a mod. The Sauce store's own file server is
     offline, so Zluggish downloads the mod from the GitHub repository the store lists for it.
   - **Install from GitHub**: paste the link of the repository (or type `owner/name`) and, if you want, a branch or tag.
   - **Install from a ZIP file**: zip the mod folder that contains `manifest.json`, up to 18 MB.
3. A new mod is disabled. Read what it does, then select **Enable** and **Enable anyway**.
4. If a window of the mod needs the internet (a web radio, map tiles), select **Internet access** for that mod.

The windows of enabled mods appear under **From mods** on the Overlay page.

## Where mods live

| What                     | Where                                                                   |
| ------------------------ | ----------------------------------------------------------------------- |
| The files of a mod       | `storage/mods/<mod-id>/`, served at `/mods/<mod-id>/...`                |
| Enabled mods, approvals  | `storage/mods/state.json`: per mod `enabled`, `approvedHash`, `network` |
| The settings a mod keeps | The rider's own settings, stored on the server per rider                |

You can also copy a mod folder into `storage/mods/` by hand. It is listed as disabled until an administrator enables it.

## The risk, and what limits it

A mod is JavaScript written by somebody else. It runs on the Overlay's address, with the session of the person who
opens its window, so it can do anything that person can do in the Overlay. There is no sandbox that would keep mods
working, so the protection is about who decides what runs:

1. Only an administrator installs, enables and removes mods, and only from a page of this server.
2. A new mod starts disabled.
3. Enabling pins the files: their SHA-256 is stored as `approvedHash`. If a file changes later, the mod is switched off
   until an administrator approves it again.
4. Archives are unpacked with limits on the file count and size, and no path may leave the mod folder. A store release
   is checked against the size and SHA-256 the store lists.
5. Mod pages get the Overlay's Content-Security-Policy: scripts only from this server (the page's own inline scripts are
   allowed by their hash), and no connection to another site unless the administrator gives the mod internet access.
   Scripts from other sites stay blocked even then.
6. The server never fetches anything for a mod page. Its only outgoing requests are the store directory and the archives
   an administrator asked to install.

Zluggish ships no mods. A mod's licence is the one its author gave it.

## Limits

- Mods that draw courses (roads, routes, segments) need world data the Overlay does not have yet.
- Mods that control the game (user actions, power-ups) or write to the world (chat, Ride Ons) need parts of the widget
  API that are not in the Overlay yet; those calls answer as not implemented.
