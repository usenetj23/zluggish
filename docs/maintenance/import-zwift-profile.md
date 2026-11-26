---
sidebar_position: 3
description: Import your official Zwift profile, and export your data.
---

# Import your Zwift profile

You can import your profile from files, or download it from your official Zwift account.

:::warning

Finish all active rides before you import.

:::

## Import

1. Sign in to the [web app](../usage/web-app.md) as the destination user.
2. On your **Profile** page, select **Import / Export**.
3. Select **Import from local files** to upload files, or **Import from Zwift** to download them from your official account.
4. For a file import, select the files. The form accepts `profile.bin`, `achievements.bin`, `economy_config.txt`, `user_storage.bin` and `streaks.bin`.
5. On the confirmation step, make sure that the source name, the source ID and the destination user are correct.
6. If the form shows a warning about a duplicate or unknown source, confirm it.
7. Start the import.

The old Python `get_profile.py` helper is not included. Use the import in the web app.

## What the import changes

- The selected profile, progression, achievement and economy files replace those categories. Zluggish makes backups first.
- Categories that you do not select, and local activities, do not change.
- The imported name replaces the name in the user list and in the game. To keep the local name, select **Keep local name**.
- The local numeric ID, login password, role and folder do not change.
- A second import replaces the progress. It does not merge it.

## Official credentials

Official credentials do not become a local password. File imports do not need official credentials.

The **Zwift connection** page keeps the credentials encrypted, for downloads and optional integrations. Activity uploads to Zwift and Zwift Click authentication are separate options on that page. See [Official Zwift uploads](../usage/integrations/zwift-and-runalyze.md).

The import does not get historical activities, and it does not synchronize. A file import does not prove that you own the official account.

To download from Zwift, the server needs access to the Zwift services. If the computer that you use for the official login redirects Zwift to Zluggish, turn off the redirection first.

:::warning

Do not copy files into `storage/<local-player-id>` or into a folder with the official player ID. The web app import checks the files and corrects the IDs and names.

:::

## Export your data

1. On your **Profile** page, select **Import / Export** and find **Export your user data**.
2. Download the user files.

## Calculate the power curves again

If your power curves look wrong:

1. Open **Settings** in the web app.
2. Select **Regenerate power curves**. Zluggish calculates them again from your saved activities.
