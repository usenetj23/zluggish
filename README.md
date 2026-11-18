<img src="https://raw.githubusercontent.com/zluggish/zluggish/main/media/zluggish.svg" alt="An orange snail with a Z" height="200">

# Zluggish

Zluggish is a self-hosted, open-source server implementation of [Zwift](http://zwift.com) written in TypeScript that implements several features not available in the official app.

This project is a rewrite of [zwift-offline](https://github.com/zoffline/zwift-offline) and [its fork](https://github.com/fatsbrown/zwift-offline). If you are migrating from either, see [Migrating](#migrating).

<img src="media/screenshots/webapp-activities.png" alt="The Zluggish web app showing a month of rides, with the route map, elevation profile and power and heart rate stats of the selected ride">

## Features

Zluggish gives you complete control over the server, including the following features:

- **Offline play**: ride without having to communicate with Zwift servers
- **Choose any map**: ride wherever you want without being constrained by the official schedule
- **Your own ghosts**: ride alongside your previous efforts and regroup ghosts through chat
- **Custom RoboPacers and pelotons**: build pacers from recorded rides and add configurable followers, with control over group size, equipment, formation, and rider strength.
- **Saved-position bookmarks**: save named places during a ride, start another session from a bookmark, or return to one using in-game teleport.
- **Intervals.icu planned workouts**: bring scheduled workouts into the game launcher and sync completed activities back to Intervals.icu. Exported TrainingPeaks `.zwo` workouts can also be imported through a local folder.
- **Web app**: manage users, settings, activities, integrations, and server operations from a browser, with no config files or CLI needed for day-to-day use
- **Local records and data**: keep profiles, activities, and recordings in storage you can back up and inspect, with optional all-time leaderboards for your server.
- **Equipment and progression control**: customize equipment availability and Drop balances on your own server, without grinding through unlocks.

Note that Zluggish is offline-only: there is no connection to Zwift's public multiplayer world. You cannot join riders on the official service, participate in its races, group rides, or club events, or compete on its global leaderboards. Local progression and records are separate from your official Zwift account. You can still ride with family or friends connected to your own Zluggish server using private multiplayer.

Everyone in the household picks themselves in the game launcher, then chooses a map and climb before starting Zwift:

<table>
  <tr>
    <td><img src="media/screenshots/launcher-riders.png" alt="The launcher's Who's riding? screen listing five riders with their avatars"></td>
    <td><img src="media/screenshots/launcher-dashboard.png" alt="The launcher after signing in, with Map and Climb choices and a Start Zwift button"></td>
  </tr>
</table>

## Requirements

Zluggish requires technical know-how to set up, so it is not for everyone. The **server** stores progress and runs ride services; the **client** is the device running the Zwift app. They can run on the same machine or on separate systems as long as they can communicate over the network.

### Server requirements

- A machine running Linux, Windows, or macOS
- Performance requirements are very low
- Docker Compose is used to run the software

### Client requirements

You will need a patched Zwift client, so the easiest method is to run it on Windows or macOS. Android is supported but [requires manual patching](#android-non-rooted). iPhone and iPad clients are not supported.

See Zwift's [official system requirements](https://support.zwift.com/en_us/supported-devices-to-run-zwift-H1Cj9QbeB) for more complete system requirements.

## Server install

If you are upgrading from legacy zwift-offline, first follow [Migrating](#migrating).

Create an empty directory on the server, for example `/etc/zluggish`, and add a `docker-compose.yml` file to it:

```yaml
services:
  zluggish:
    image: ghcr.io/zluggish/zluggish:latest
    volumes:
      - /etc/localtime:/etc/localtime:ro
      - ./storage:/usr/src/app/zluggish/storage
    ports:
      - 80:80
      - 443:443
      - 8080:8080
      - 3024:3024/udp
      - 3025:3025
    restart: unless-stopped
```

Then start the server from that directory:

```sh
docker compose up -d
```

The `storage` folder next to `docker-compose.yml` is created on first startup and holds the configuration, users and activities. To update, run `docker compose pull && docker compose up -d`.

To build from source instead, clone this repository and run `docker compose -f docker/docker-compose.yml up --build` from the repository root. That setup uses `storage` in the repository root.

You should see output similar to:

```sh
zluggish-1  | 2026-11-17T11:40:23.126Z INFO server.ready Zluggish is ready
```

### First-time setup

The first administrator must prove access to the server using a setup key. Until setup is completed, and while the web app is enabled (the default), the server generates a key at each startup and prints it in the **Zluggish first-time setup** block in its startup output. Keep this key private: it authorizes creation of the first administrator.

1. Start the server. Read the **Open:** address and **Setup key:** from the terminal, or retrieve them from the container logs:

   ```sh
   docker compose logs zluggish
   ```

2. Open the printed setup address (by default, `http://<server-ip>:8080/setup`). Paste the key into **Setup key** and select **Check key**. Case, spaces and hyphens do not matter.
3. After **Setup key accepted** appears, enter a name, login name and password to create a new user. When migrating, you can instead choose **Use an existing user**, select an enabled user with a password, and enter that user's password. Users without passwords need [CLI account recovery](server/README.md#recover-a-local-account) first.
4. Select **Complete setup**. The chosen user becomes the first administrator and is signed in automatically. The setup key is invalidated; future sign-ins use the user's login name and password.
5. Open **Manage → Users** and create the other users with passwords.
6. Start Zwift, select your user in the game and sign in with the user's username and password. Android uses native credential login, so every user needs a password; there is no passwordless picker.

The key works only until setup completes or the server stops. If the server restarts before setup completes, use the new key from the latest startup output. After setup completes, restarting does not issue another key; use [CLI account recovery](server/README.md#recover-a-local-account) if you lose administrator access.

### Server configuration and CLI

The server image also includes the full admin CLI, with no Node or pnpm installation needed on the host:

```sh
docker compose run --rm --no-deps zluggish zluggish --help
```

It uses the same mounted storage as the server. Stop the server before commands that change accounts, migrate config, or write user settings. See the [admin CLI guide](server/README.md) for commands and offline operation.

The container creates `storage/zluggish.config.ts` on first startup if it does not exist. Edit this file to change settings, then recreate the container. For example:

```ts
import { defineConfig } from 'zluggish/config';

export default defineConfig({
  storageDir: '../storage',
  server: { advertisedIp: '192.168.1.10' },
  network: { host: '0.0.0.0', api: { port: 443, useCert: true } },
});
```

`server.advertisedIp` must be a non-wildcard IP address reachable by the game. Listener hosts must be non-empty IP addresses or hostnames; use `0.0.0.0` to listen on all IPv4 interfaces. Invalid or unknown settings prevent startup.

The web app listener is configured under `network.web`:

```ts
network: {
  web: {
    enabled: true, // set to false after setup to turn the web app off, see Web app
    host: null, // defaults to network.host
    port: 8080,
    publicUrl: 'https://zluggish.example.com', // behind a reverse proxy, see Web app
  },
},
```

After completing [first-time setup](#first-time-setup), connect the client.

## Client configuration

### Windows

- Install Zwift if it is not already installed
- **NOTE:** Instead of performing the steps below, you can run the **configure_client** script from the [zoffline-helper release page](https://github.com/oldnapalm/zoffline-helper/releases/latest).
- On your Windows machine running Zwift, copy the following files from this repository to a known location:
  - [assets/ssl/cert-zwift-com.p12](assets/ssl/cert-zwift-com.p12)
  - [assets/ssl/cert-zwift-com.pem](assets/ssl/cert-zwift-com.pem)
- Open Command Prompt as an administrator, change to that directory, and run:
  - `certutil.exe -importpfx Root cert-zwift-com.p12`
  - If you're prompted for a password, just leave it blank. There is no password.
- Open Notepad as an administrator and open `C:\Program Files (x86)\Zwift\data\cacert.pem`
  - Append the contents of `assets/ssl/cert-zwift-com.pem` to `cacert.pem`
- Open Notepad as an administrator and open `C:\Windows\System32\Drivers\etc\hosts`
  - Append this line: `<server-ip> us-or-rly101.zwift.com secure.zwift.com cdn.zwift.com launcher.zwift.com`
    <br />(Where `<server-ip>` is the IP address of the machine running Zluggish. If
    it's running on the same machine as Zwift, use `127.0.0.1` as the IP address.)
- The retained `scripts/configure_client.bat` helper configures local client redirection to `127.0.0.1`; use the manual steps above for a separate server. `scripts/launch.bat` temporarily redirects the client to the address in `scripts/ip_address.txt`, launches Zwift, and restores the hosts file when you continue past its pause. It does not start the server.

Why: We need to redirect Zwift to use Zluggish and convince Windows and Zwift to
accept Zluggish’s self-signed certificates for Zwift's domain names. Feel free
to generate your own certificates and do the same.

### macOS

- Install Zwift if it is not already installed
- On the Mac running Zwift, copy the file [assets/ssl/cert-zwift-com.pem](assets/ssl/cert-zwift-com.pem) from this repository to a known location.
- Open Keychain Access, select "System" under "Keychains", select "Certificates" under "Category"
  - Click "File - Import Items..." and import cert-zwift-com.pem
  - Right-click "\*.zwift.com", select "Get Info" and under "Trust" choose "When using this certificate: Always Trust".
- From the cert-zwift-com.pem location, run `sed -n '29,53p' cert-zwift-com.pem >> ~/Library/Application\ Support/Zwift/data/cacert.pem`
- Using a text editor with administrator privileges, open `/etc/hosts`
  - Append this line: `<server-ip> us-or-rly101.zwift.com secure.zwift.com cdn.zwift.com launcher.zwift.com`
    <br />(Where `<server-ip>` is the IP address of the machine running Zluggish. If
    it's running on the same machine as Zwift, use `127.0.0.1` as the IP address.)

Why: We need to redirect Zwift to use Zluggish and convince macOS and Zwift to
accept Zluggish’s self-signed certificates for Zwift's domain names. Feel free
to generate your own certificates and do the same.

### Android (non-rooted)

- Install the required apps:
  - Download and install `ZofflineObb.apk` from [here](https://github.com/fatsbrown/ZofflineObbAndroid/releases/latest)
  - Download and install `app-Github-release.apk` from [here](https://github.com/x-falcon/Virtual-Hosts/releases/latest)
  - Create a `hosts.txt` file to use with the app (you could use a text editor app or create it online with an online tool such as [this](https://passwordsgenerator.net/text-editor/)). The file must look like this (replace `<server-ip>` with the IP address of the machine running Zluggish):
    ```
    <server-ip> us-or-rly101.zwift.com
    <server-ip> secure.zwift.com
    <server-ip> cdn.zwift.com
    ```
  - Turn off "Private DNS" in Android settings
  - Run "Virtual Hosts" and select the created `hosts.txt` file
  - Optionally, instead of using the "Virtual Hosts" app, you can set `dns.enabled` to `true` in `zluggish.config.ts` and set "DNS 1" for your phone’s Wi-Fi connection to the IP address of the PC running Zluggish
  - Note: If you know what you're doing and have a capable enough router, you can adjust your router to alter these DNS records instead of using the "Virtual Hosts" app or changing your phone’s DNS settings.
- Patch after every installation or update:
  - Install or update Zwift from Google Play, but do not start it yet.
    - If you have already started it, go to `Android Settings > Applications > Zwift` and clear data or uninstall and reinstall the app.
  - Open the "ZofflineObb" app and run it (allow access to all files and install from unknown sources)
    - If the app doesn't work on your device, you can patch the OBB file on Windows. See [#505](https://github.com/zoffline/zwift-offline/issues/505) for details.
  - Wait for the process to finish (5–10 minutes)
  - Run Zwift. It should verify the download and start.
- Play Zwift:
  - The Virtual Hosts button must be ON
  - Ask an administrator to create your user in the [web app](#web-app) (**Manage → Users**) with a password, then sign in with that user's username and password.

Why: We need to redirect Zwift to use Zluggish (this is done by the Virtual Hosts app) and convince Zwift to
accept Zluggish’s self-signed certificates for Zwift's domain names (this is done by the patch tool ZofflineObb).

#### Android (rooted)

- Install Zwift on the device
- Open Zwift once to complete installation (i.e., download all extra files).
- Append the contents of `assets/ssl/cert-zwift-com.pem` to `/data/data/com.zwift.zwiftgame/dataES/cacert.pem` on the device
  - Note: this file will only exist after the first run of Zwift since it's downloaded after the initial install
  - If your device does not have a text editor, use these commands:
    - `adb push assets/ssl/cert-zwift-com.pem /data/data/com.zwift.zwiftgame/dataES/`
    - In `adb shell`: `cd /data/data/com.zwift.zwiftgame/dataES/`
    - In `adb shell`: `cat cert-zwift-com.pem >> cacert.pem`
    - However you do it, ensure the permissions and ownership of the file remain the same.
- Modify the device's `/etc/hosts` file
  - Append this line: `<server-ip> us-or-rly101.zwift.com secure.zwift.com cdn.zwift.com`
    <br />(Where `<server-ip>` is the IP address of the machine running Zluggish.)
  - If the device has no text editor, use these steps:
    - `adb pull /etc/hosts`
    - Modify the file on your PC
    - `adb push hosts /etc/hosts`
  - Note: If you know what you're doing and have a capable enough router, you can adjust your router to alter these DNS records instead of modifying your `hosts` file.
- Ask an administrator to create your user in the [web app](#web-app) (**Manage → Users**) with a password, then sign in with that user's username and password.

Why: We need to redirect Zwift to use Zluggish and convince Zwift to
accept Zluggish’s self-signed certificates for Zwift's domain names. Feel free
to generate your own certificates and do the same.

## Uninstalling Zluggish

To restore normal Zwift operation, comment out or remove the line added to the `hosts`
file before starting Zwift. Then ensure Zwift is fully closed (right-click
the Zwift system tray icon and exit) and restart Zwift.

## Importing your official Zwift profile

Sign in to the [web app](#web-app) as the destination user and open **Import**. Choose **Local files** to upload files, or **Zwift connection** to download them from your official account. The file import form accepts `profile.bin`, `achievements.bin`, `economy_config.txt`, `user_storage.bin` and `streaks.bin`. The former Python `get_profile.py` helper has been removed; use the built-in import.

Review the source name/ID and destination user on the confirmation step before importing. Selected profile/progression, achievement and economy files replace those categories with backups; unselected categories and local activities stay unchanged. Imported names update both the user list and in-game profile unless **Keep local name** is selected. Imports preserve the local numeric ID, login password, role and folder. Reimport replaces progress rather than merging it. Duplicate/unknown source warnings require confirmation. Finish active rides before importing.

Official credentials do not become a local password. The **Zwift connection** page saves them encrypted for downloads and optional integrations; file imports need no official credentials. Uploading activities to Zwift and Zwift Click authentication are separate opt-in checkboxes on that page. Importing does not fetch historical activities or enable ongoing synchronization. File imports do not prove official-account ownership.

Do not copy files blindly into `storage/<local-player-id>` or a folder named after the official player ID. Use the web app import so files are validated and IDs/names are normalized. Official downloads need access to Zwift services; client redirection may need to be disabled on the machine used for official login.

To take your data with you, open **Export** and download the user files. If your power curves look wrong, open **Settings** and choose **Regenerate power curves** to rebuild them from your saved activities.

## Sharing activities

Connections belong to the signed-in user and are managed under **Integrations** in the [web app](#web-app). Completed activities are saved locally before uploads; a failed upload to one provider does not delete the saved activity. Live provider authorization and delivery still need verification for this TypeScript migration.

<img src="media/screenshots/webapp-integrations.png" alt="The Integrations page with Strava, Garmin, Intervals.icu and TrainingPeaks connected, and a list of recent activity uploads">

<details><summary>Strava</summary>

Two upload methods are available. Choose one with **Upload method** under **Integrations → Strava**:

- **API application:** obtain a client ID and secret from [Strava API settings](https://www.strava.com/settings/api), set the authorization callback domain to the web app's hostname (the host of `network.web.publicUrl`, or the address you open the web app at), save the credentials under **Integrations → Strava** and choose **Authorize**. Existing `storage/<local-player-id>/strava_token.txt` files are reused. API access depends on Strava's current application/account policy.
- **Browser session cookie:** sign in to Strava in a browser, open developer tools, find `_strava4_session` under Application/Storage → Cookies, and paste it into **Strava session cookie**. Select the session-cookie upload method and use **Test session**. Treat this cookie as a credential.

Screenshot upload uses the session-cookie method rather than the API. The old Python authorization helper is no longer needed or included.

</details>

<details><summary>Garmin Connect</summary>

Open **Integrations → Garmin**, save the credentials and choose **Authorize**. Enter the verification code if Garmin requests MFA. Authorization and FIT uploads now run in TypeScript; there is no Python helper or separate Garmin image.

Existing `oauth1_token.json` and `oauth2_token.json` files from garth can remain in `storage/<local-player-id>/garth/`. For a China account, set `integrations.garmin.domain: 'garmin.cn'` in operator config. Live Garmin login/upload remains a verification gate.

</details>

<details><summary>Intervals.icu and planned workouts</summary>

Open **Integrations → Intervals.icu**. Copy the athlete ID and API key from [Intervals.icu settings](https://intervals.icu/settings), under Developer Settings, and save them there. The provider refreshes automatically when you sign in to the launcher. Android game login also refreshes Intervals.icu when reusing saved login tokens. Automatic network refreshes have a five-second deadline and retain cached workouts on failure; **Sync workouts** under **Integrations → Intervals.icu** refreshes them on demand. Cycling workouts appear in the launcher; completed activities can be uploaded and paired with their planned workout.

Exported TrainingPeaks `.zwo` files can be imported through a local bridge folder. Set **Export folder** under **Integrations → TrainingPeaks** or the `workouts.trainingpeaks.bridgeFolder` preference, then choose **Import workouts** there; paths must be accessible to the server, including inside Docker when used.

</details>

<details><summary>Official Zwift uploads and Runalyze</summary>

Official Zwift upload credentials and opt-in upload settings are separate from local passwords and profile import. Open **Import → Zwift connection** to save credentials and independently enable activity uploads or Click authentication.

The Runalyze adapter reads the user's existing `storage/<local-player-id>/runalyze_token.txt` file. Keep integration credentials private and preserve encryption keys when moving existing storage.

</details>

## The Zwift Companion app

<details><summary>Android (non-rooted device)</summary>

- Download and install the patched APK from [here](https://github.com/fatsbrown/zoffline-companion/releases/latest) (or [patch it yourself](https://github.com/fatsbrown/zoffline-companion#patch-it-yourself))
- Download and install `app-Github-release.apk` from [here](https://github.com/x-falcon/Virtual-Hosts/releases/latest)
- Create a `hosts.txt` file to use with the app (you could use a text editor app or create it online with an online tool such as [this](https://passwordsgenerator.net/text-editor/)). The file must look like this (replace `<server-ip>` with the IP address of the machine running Zluggish):

  ```
  <server-ip> us-or-rly101.zwift.com
  <server-ip> secure.zwift.com
  ```

  - Important: don't add `cdn.zwift.com` to `hosts.txt`; Companion needs to download images from the official server

- Turn off "Private DNS" in Android settings
- Run "Virtual Hosts" and select the created `hosts.txt` file
- Optionally, instead of using the "Virtual Hosts" app, you can set `dns.enabled` to `true` in `zluggish.config.ts` and set "DNS 1" for your phone’s Wi-Fi connection to the IP address of the PC running Zluggish
- Note: If you know what you're doing and have a capable enough router, you can adjust your router to alter these DNS records instead of using the "Virtual Hosts" app or changing your phone’s DNS settings.

</details>

## Web app

The web app is where users and administrators work with Zluggish. Use it only on a network that you trust: other devices on the network can read the passwords that users type unless you put it behind HTTPS.

To create the first administrator, follow [First-time setup](#first-time-setup) under Server install.

Behind a reverse proxy, set `network.web.publicUrl` to the address users open, for example `https://zluggish.example.com`. The web app then accepts requests only from that address, and an `https` URL marks sign-in cookies `Secure`.

First-time setup and creating users need the web app. After setup, an administrator can set `network.web.enabled: false` to turn it off. While it is off, nobody can create or manage users, browse activities, or change settings and integrations from a browser. Rides keep working: users who already have a password can still sign in through the game launcher, and activities are still saved and uploaded. Turn it back on and restart the server when you need it again.

### User pages

Every user has these pages in the menu:

| Page         | Use                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------- |
| Profile      | View and edit your profile and avatar, and change your password                                 |
| Activities   | Browse saved activities by month, see route, elevation and stats, download FIT files and images |
| Import       | Import profile data from local files or from your official Zwift account                        |
| Export       | Download your user data                                                                         |
| Integrations | Connect Strava, Garmin, Intervals.icu and TrainingPeaks, and follow activity uploads            |
| Settings     | Ride with ghosts, and regenerate power curves                                                   |

<table>
  <tr>
    <td><img src="media/screenshots/webapp-profile.png" alt="The Profile page with avatar, name, email and birthday"></td>
    <td><img src="media/screenshots/webapp-settings.png" alt="The Settings page with the Ride with ghosts option and Regenerate power curves"></td>
  </tr>
</table>

### Administrator pages

Administrators also see **Users** and **Server** under **Manage**:

- **Users**: create users, enable or disable them, grant or remove the administrator role, set passwords, end sessions, delete users, and edit a user's settings.
- **Server**: reload or command bots, edit stored world settings such as blob and peloton overrides, edit and delete events, and view the effective configuration. Changes to `zluggish.config.ts` still require a restart.

<img src="media/screenshots/webapp-users.png" alt="The Users page listing five users, with an administrator, a disabled user and a user who is riding now">

### Ports

For a separate server, set `server.advertisedIp` and allow the ports below on the local network. This enables private household riding, not access to Zwift's public multiplayer world.

| Port | Protocol | Use                                |
| ---- | -------- | ---------------------------------- |
| 80   | HTTP     | Zwift CDN only                     |
| 443  | HTTPS    | Game app and Zwift API only        |
| 8080 | HTTP     | Web app (users and administrators) |
| 3025 | TCP      | Game connection                    |
| 3024 | UDP      | Ride data                          |
| 53   | UDP      | Optional DNS (`dns.enabled`)       |

## Password recovery

Users change their own password with **Change password** on the **Profile** page, and administrators set another user's password under **Manage → Users**. If nobody can sign in, use the recovery CLI below.

Stop the server before using the recovery CLI. Put the new password in a private file, then run from the repository root:

```sh
pnpm --dir server cli --storage-dir /path/to/storage accounts recover --user 1 --password-file /private/path/new-password.txt --admin
```

Remove the private password file after recovery. The `--admin` option also enables the user and grants the administrator role. Omit `--admin` to preserve the role and enabled state. Users cannot be left without a password. The CLI revokes existing sessions. It does not prompt interactively for a password. Gmail/SMTP reset links are no longer supported.

## IPv6 (Optional)

Set `network.host: '::'` in `zluggish.config.ts`, or choose per-listener `host` values under `network.api`, `network.cdn`, `network.tcp` and `network.udp`. Configure a client-reachable `server.advertisedIp` and matching firewall/host mappings. IPv6 behavior still needs target-platform testing; the old `ZOFFLINE_SERVER_HOST` variable and Python `run_ipv6.bat` startup path are not used by Node.

## Migrating

Zluggish is a rework of the legacy zwift-offline app. Here are the key differences:

- Codebase rewritten in TypeScript
- Svelte web app for managing users, server settings, activities and integrations
- Improved persistence layer and settings management

We aim to import and convert your storage automatically, but we strongly suggest you back up your zwift-offline folder before attempting the upgrade.

After the upgrade, you will need to set user passwords again. During [first-time setup](#first-time-setup) in the web app, choose an existing migrated user that has a password to become the administrator; users without a password need one set with the [admin CLI](server/README.md) first.

## Extra features

<details><summary>Ghosts</summary>

- Ghosts are enabled by default. Change "Ride with ghosts" in the web app’s Settings to enable or disable them for your user.
- When you save an activity, the ghost will be saved in `storage/<player_id>/ghosts/<world>/<route>`. Next time you ride the same route, the ghost will be loaded.
- Type `.regroup` in chat to regroup the ghosts.
- Legacy ghost appearance settings used `storage/ghost_profile.txt`. The migration preserves its path as `ghosts.profileFile`, but current TypeScript playback uses the local user profile and does not apply that override yet. The old `find_equip.py` helper is not included.

</details>

<details><summary>Bots</summary>

- Set `bots.enabled` to `true` in `zluggish.config.ts` to load ghosts as bots; they keep riding regardless of your route.
- Set `bots.multiplier` to an integer from 1 to 100 to duplicate bots. Large numbers can affect performance.
- Type `.group` in chat to group the bots, or `.groupall` to include duplicates (if using a multiplier). Type `.autogroup` or `.autogroupall` to automatically group whenever you change roads. Type `.stopautogroup` to stop automatic grouping, or `.disperse` to randomize positions.
- Names, nationalities and equipment can be customized by creating a file `bot.txt` inside the `storage` folder. The former Python catalogue helper is not included; preserve an existing catalogue and set `bots.ridersFile` to its path in `zluggish.config.ts`.
- If you want some random bots, check [this repository](https://github.com/oldnapalm/zoffline-bots).

</details>

<details><summary>RoboPacers</summary>

- RoboPacers are ghosts saved using a power simulator. You can find some in [this repository](https://github.com/oldnapalm/zoffline-bots).
- The ghost must be recorded using an update frequency of 1 second (the default is 3 seconds).
- The activity must start and finish at the same position and speed; otherwise the bot won't loop smoothly.
- The profile must contain a unique player ID and the route ID, so that when you join the bot you take the same turns at intersections.
- Store each pacer’s `profile.bin` and `route.bin` in `storage/robopacers/<pacer-name>/`. The old Python `bot_editor.py` helper has been removed; use an existing compatible recording or external tooling to prepare its ID, route and loop.
- If you want to create a dynamic RoboPacer (increase power on climbs and decrease it on descents), you can use [standalone_power.py](https://github.com/oldnapalm/zwift-offline/blob/master/standalone_power.py) (requires 2 ANT sticks, [python-ant](https://github.com/mch/python-ant) and [PowerMeterTx.py](https://github.com/oldnapalm/zwift-offline/blob/master/PowerMeterTx.py)).

</details>

<details><summary>Pelotons (RoboPacer + follower bots)</summary>

- A peloton consists of one RoboPacer followed by a custom group of bots riding in formation around and behind it, so joining the pacer feels like riding in a real group.
- Followers move up and back inside the group, drift laterally, stretch out on climbs (weaker riders lose some meters and come back on the flat), coast on descents and show realistic power (drafting), cadence and heart rate.
- Quick way: ride next to a RoboPacer and type `.peloton 20` in chat (`.peloton` shows the current size, `.peloton off` removes it). Chat changes persist as SQLite overrides; they do not rewrite `zluggish.config.ts`.
- Or add a `pelotons` array to `zluggish.config.ts`. Each entry needs a stable `id` and a `pacer` (the folder name inside `storage/robopacers` or its player ID). Other fields have defaults:

```ts
import { defineConfig } from 'zluggish/config';

export default defineConfig({
  pelotons: [
    {
      id: 'volcano-group',
      pacer: 'B - 3.3 WKG - Watopia - Volcano Climb',
      bots: 25,
      columns: 0,
      rowGap: 2.2,
      lateralSpacing: 65000,
      besidePacer: 2,
      dynamics: 1,
      shuffleInterval: 30,
      draft: 0.7,
      climbStretch: 1,
      maxDrop: 40,
      riders: [
        {
          firstName: 'Tadej',
          lastName: 'Pogacar',
          countryCode: 705,
          isMale: true,
          position: 'front',
          strength: 1.3,
        },
        {
          firstName: 'Ana',
          lastName: 'Lopez',
          isMale: false,
          weight: 55,
          position: 'back',
          strength: 0.85,
        },
      ],
    },
  ],
});
```

- `bots`: total followers (max 200). Riders not listed in `riders` get random names (from the `bots.ridersFile` catalogue when configured) and random equipment.
- `columns`: max width of the group (0 = automatic). `rowGap`: meters between rows. `lateralSpacing`: lateral distance between riders in `roadPosition` units (100000 = 1 meter, default 0.65 m). `besidePacer`: riders alongside the pacer.
- `dynamics`: 0 = rigid formation, 1 = normal, 2 = very lively. `shuffleInterval`: average seconds between position changes. `draft`: fraction of power used by a rider on a wheel. `climbStretch` and `maxDrop`: how much the group stretches on climbs.
- Each rider in `riders` uses camelCase profile fields such as `firstName`, `lastName`, `countryCode`, `bikeFrame` and `rideJersey`, plus `position` (`front`, `middle`, `back` or `any`), `strength` (0.5 - 1.5), `weight` (kg), `height` (cm), `cadence` (rpm) and `maxHeartRate`.
- Restart after editing operator config; it is not watched for changes. Set `enabled: false` to disable a configured peloton without deleting it. Live chat overrides remain in SQLite.

</details>

<details><summary>Solo blob</summary>

- A solo peloton "blob" is a group of bots that swarm around the player, in real time - no RoboPacer needed.
- The bots ride the actual trail you just rode (real corners, hills and speed), sit wheel to wheel behind you to use the draft, mix and rotate: somebody comes up to your handlebars, pulls for a while, then drifts back through the group and somebody else takes over.
- Chat commands:
  - `.blob <n>` - start/keep a blob of n riders around you
  - `.blob` - show status
  - `.blob new` - same number of riders, new faces
  - `.blob off` - stop
  - `.blob jokes` - switch the joke rider on or off (see below)
- Gestures (F-keys) that move the group:
  - Elbow (F1) - come and pass me
  - Hammertime (F4) - full gas, segment on
  - I'm toast (F7) - easing off
  - Bell (F8) - I want a turn in front
- Joke rider (off by default): set `soloBlob.jokes` to `true`, or tick `jokes` in the world settings of the web app. While you ride, the bot furthest ahead tells you a joke in the chat now and then, under its own name. `jokeInterval` is the average number of seconds between two jokes (default 300) and `jokeLanguage` is `auto`, which follows the flag of your profile and falls back to English, or a language from `assets/data/jokes.txt` (English and Polish are included; add your own lines or a new language there). Jokes do not repeat until the whole list of a language has been told.
- With the joke rider on, the same bot also remarks on your ride (`jokeCommentary`, on by default): the route about a minute and a half in, every 15 minutes and every 10 km, a climb or a descent, a clearly stronger or weaker last minute, and how hard you are riding against your FTP (`ftp` in watts, or `0` to take it from your Zwift profile) with a question after a burst over FTP. A sprint or KOM you finish is told at once with your earlier times on it, and a bot that gives a hand signal says a line with it (`gestureTalk`, the chance from 0 to 1, default 0.5). `commentaryGap` is the least number of seconds between two remarks (default 120). The texts, in English and Polish, are in `assets/data/commentary.txt`; add your own or a new language there.

</details>

<details><summary>Bookmarks</summary>

- When you finish an activity, your last position will be saved as a bookmark.
- Bookmarks can also be saved using the command `.bookmark <name>` in the chat.
- You can start a new activity from a bookmark by selecting it in "Join a Zwifter" on the home screen.
- You can teleport to a bookmark using the teleport icon on the action bar.

</details>

<details><summary>All-time leaderboards</summary>

- To enable all-time leaderboards (overriding the 60-minute window for live results and the 90-day window for personal records), set `leaderboards.allTime` to `true` in `zluggish.config.ts`.
- Jerseys are still valid for 60 minutes but will be granted only when a new all-time record is set.

</details>

<details><summary>Entitlements</summary>

- To unlock entitlements (special equipment), set `equipment.unlockEntitlements` to `true` in `zluggish.config.ts`.
- To unlock bike upgrades, set `equipment.unlockBikeUpgrades` to `true` in `zluggish.config.ts`.
- To unlock all equipment, set `equipment.unlockAll` to `true` instead.

</details>

<details><summary>CDN proxy</summary>

- `proxy.mode` accepts `'auto'` (default), `'enabled'` or `'disabled'` in `zluggish.config.ts`.
- Bundled files are served from `assets/cdn/`. Missing game assets can be requested from Zwift through the proxy; upstream resolution uses Google public DNS independently of client host redirects. Use `'disabled'` for local-only assets. Live proxy behavior remains part of manual verification.
- The former `get_gameassets.py` downloader is no longer included. Preserve any existing asset cache under the new CDN asset directory and rebuild the image after changing bundled files.

</details>

<details><summary>Discord bridge</summary>

The bridge runs in the Node server, including Docker. Create a private `storage/discord.cfg` file:

```ini
[discord]
token = YOUR_BOT_TOKEN
webhook = YOUR_CHANNEL_WEBHOOK_URL
```

Then configure operator settings, using a path relative to the config file (this example assumes `examples/zluggish.config.ts`):

```ts
import { defineConfig } from 'zluggish/config';

export default defineConfig({
  integrations: {
    discord: {
      enabled: true,
      credentialsFile: '../storage/discord.cfg',
      channel: '123456789012345678', // Replace with your channel ID.
      welcomeMessage: 'Welcome!',
      helpMessage: 'Ride with us on the local server.',
      announcePlayers: true,
    },
  },
});
```

Enable guild-member and message-content intents for the bot. The bridge supports configured-channel chat, welcome and join/leave announcements, online presence, and `!online`, `!ping` and `!help` commands. Keep tokens/webhooks private. Live gateway and webhook delivery still need verification with a test guild.

</details>

<details><summary>Matrix bridge (experimental)</summary>

Matrix support is experimental and has not yet been verified against a live homeserver. The bridge runs in the Node server, including Docker, and can run alongside the Discord bridge. Create a private `storage/matrix.cfg` file with the bot's password:

```ini
[matrix]
password = YOUR_BOT_PASSWORD
```

or, for a homeserver without password login, an access token for the bot:

```ini
[matrix]
access_token = YOUR_BOT_ACCESS_TOKEN
```

Then configure operator settings, using a path relative to the config file (this example assumes `examples/zluggish.config.ts`):

```ts
import { defineConfig } from 'zluggish/config';

export default defineConfig({
  integrations: {
    matrix: {
      enabled: true,
      credentialsFile: '../storage/matrix.cfg',
      homeserver: 'https://matrix.example.org',
      user: '@zluggish:matrix.example.org',
      room: '#ride:matrix.example.org', // A room alias or a room ID such as '!abc123:matrix.example.org'.
      helpMessage: 'Commands: !online, !ping, !help. Other messages are relayed to riders in-game.',
      announcePlayers: true,
    },
  },
});
```

- `homeserver` is the client-server API URL. The server does not follow `.well-known` delegation, so use the URL your Matrix client connects to.
- The bot joins the room on startup. It must already be a member, be invited, or the room must be public.
- Room chat is relayed to riders in-game, and in-game chat is posted to the room as `Name: message`. `!online`, `!ping` and `!help` are answered in the room.
- Encrypted rooms are not supported. The bridge logs a warning and never posts into an encrypted room.
- After a password login, the session is kept in `storage/matrix-session.json` so restarts reuse the same device. Keep this file private.

</details>

## Community Discord server and Strava club

Please join the community-supported [Discord](https://discord.gg/GMdn8F8) server and [Strava](https://www.strava.com/clubs/zoffline) club.

## Dependencies

Use Docker, or Node 24 and pnpm 12 for a source installation. The web app is built with Svelte and Vite (see `web/`; Docker builds it for you). Runtime dependencies include Hono and its Node adapter, protobuf codecs, SQLite through Node's built-in module, native OS storage locks, Zod, Jiti, the Garmin FIT/Connect libraries and discord.js. Package manifests and lockfiles in `server/` are authoritative. No Python runtime or pip dependencies are required.

## Note

Future Zwift updates can break compatibility. Client redirection can interfere with normal updates; switch back to the official service before updating, then recheck compatibility. See [CHANGELOG](CHANGELOG) for changes that may require operator action.

Keep Zluggish on a trusted local network; it is not designed for public Internet exposure.

<details><summary>If Zluggish is behind the official client</summary>
Updating the advertised client version may let a newer client start, but does not establish protocol compatibility.

- Windows: copy `C:\Program Files (x86)\Zwift\Zwift_ver_cur.xml` to Zluggish's `assets/cdn/gameassets/Zwift_Updates_Root/` overwriting the existing file.
- macOS: copy `~/Library/Application Support/Zwift/ZwiftMac_ver_cur.xml` to Zluggish's `assets/cdn/gameassets/Zwift_Updates_Root/` overwriting the existing file.
- Linux/server-only deployments: obtain the version XML from the client installation and place it in the same `assets/cdn/gameassets/Zwift_Updates_Root/` directory. Historical upstream version-update helpers assume the old directory layout.

There is no guarantee that an untested Zwift update will work. Rebuild the Docker image after updating bundled assets, and verify client compatibility before changing a working installation.

Alternatively, [this script](https://gist.github.com/oldnapalm/556c58448a6ee09438b39e1c1c9ce3d0) can be used to downgrade Zwift to the version supported by your server.

</details>

<details><summary>Update failed during patching</summary>

If you get this error even though Zluggish is up to date, rename the file `Zwift_ver_cur.<version>.xml` in the Zwift directory to `Zwift_ver_cur.xml` and edit the file `Zwift_ver_cur_filename.txt` accordingly.

</details>

## Development

Install [mise](https://mise.jdx.dev/getting-started.html), then run from the repository root:

```sh
cd server
mise install
mise run install
mise run check
```

Build the web app with `pnpm --dir web build`, and type-check it with `pnpm --dir web check`. Regenerate the screenshots in this README, from fictional riders on a throwaway server, with `pnpm --dir server screenshots`. For individual pnpm commands and lint provenance, see the [CLI/tooling guide](server/README.md).

## Legal notice

Zluggish is an independent, community-developed project. It is **not affiliated with, endorsed by, sponsored by, or officially supported by Zwift, Inc.** Zwift is a trademark of Zwift, Inc. Other product and company names belong to their respective owners; references to them do not imply affiliation or endorsement.

Zluggish is licensed under the **GNU Affero General Public License, version 3 (AGPL-3.0)**. See [LICENSE](LICENSE) for the full terms, including the warranty disclaimer. Third-party components retain their respective licenses and copyright notices. This license does not grant rights to Zwift's proprietary client, game assets, or trademarks.

This project is based on [zwift-offline](https://github.com/zoffline/zwift-offline) and [fatsbrown's fork of zwift-offline](https://github.com/fatsbrown/zwift-offline). Credit for that foundation belongs to their authors and contributors.

## Logging

The default `INFO` level reports user login, game connections, companion registration,
ride start/progress/end, activity saves, and upload outcomes. Routine HTTP requests
appear only at `VERBOSE`.

```ts
logging: {
  level: 'INFO', // VERBOSE, INFO, WARN, ERROR, CRITICAL, or NOTSET
  format: 'pretty', // or 'json' for one structured record per line
  rideProgressIntervalSeconds: 60, // 0 disables progress; otherwise at least 10
},
```

`DEBUG` is accepted as a legacy alias for `VERBOSE`, and `WARNING` for `WARN`.
Each line includes a UTC timestamp, level, event name, message and context. JSON
records put context in `fields`. INFO/VERBOSE go to stdout; warnings and errors go
to stderr. Use your process manager for log retention and rotation.

A ride starts on the first accepted world state, including a stationary rider.
Progress includes elapsed seconds and distance in metres; a counter reset is
flagged. Reconnecting transport does not start another ride. A ride ends on
logout, inactivity cleanup, or shutdown; this does not imply that an activity was
saved. Only successful durable finalization emits `activity.saved`, with recovery
marked separately. External upload failures require a retry from the web app, under **Integrations → Activity uploads**.

Companion phone registration emits `companion.registered`. It does not establish
a persistent connection, so logs do not claim a companion disconnect. Repeated
registrations are deduplicated within a two-minute activity window.

VERBOSE request summaries use route templates and exclude query strings and
request bodies. Credentials and packet payloads are not logged. Exceptions record
their type rather than arbitrary provider messages or stacks, which may contain
credentials. Player IDs identify users without logging their names or emails.
