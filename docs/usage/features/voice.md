---
sidebar_position: 10
description: The browser reads the chat and the blocks of your workout aloud.
---

# Voice

The **Voice** page of the web app reads the ride aloud with the voice of your browser. Open it in the browser on the device you ride with, select **voice: on** and keep the tab open.

## What is read

- Chat messages of the game, in the language they are written in. Your own messages are off by default.
- The workout. When the game fetches a workout from the server, the page reads its summary at once, each block a few seconds before it starts, a countdown before a block ends, and the end of the workout.

The workout is read on a clock that starts when the game fetches the file. A pause in the game moves the game, not the clock.

## Settings

The page lets you choose the language (Polish or English), the voice, the speed and the volume, and which kinds of messages are read. The browser remembers them.

## Follow the segments of the game

The clock does not know when the game really starts a segment of the workout, or what the workouts bundled in the game contain. The server can read both from the log that the Zwift client writes. The voice then reads each block when the game starts it, the target watts of the screen, and the captions of the workout. A pause no longer shifts anything.

| Setting         | Default                      | Meaning                                                                                                                |
| --------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ZWIFT_LOG`     | `/zwift-logs/Log.txt`        | The log of the Zwift client. In Docker, mount the folder `Documents/Zwift/Logs` of the computer you ride with.         |
| `ZWIFT_LOG_URL` |                              | Read the log over HTTP instead of from a file. Use it when the mounted file shows its growth late.                     |
| `ZWIFT_WAD`     | `/zwift-assets/workouts.wad` | The workout archive of the game, which names the bundled workouts. Mount the folder with `workouts.wad` of your Zwift. |
| `ZWIFT_FTP`     | `0`                          | Your FTP in watts. When it is `0`, the voice works the FTP out from the first target watts that the game sets.         |

Without the log, chat and workouts that the game fetches from the server are still read, on the clock.

:::note

On macOS, a file that Docker mounts shows its growth minutes late. Serve the log from the host to `ZWIFT_LOG_URL` with any small HTTP server that answers `GET /zwift-log?offset=N` with the new bytes of the log and the headers `X-Log-Size` and `X-Log-Start`.

:::
