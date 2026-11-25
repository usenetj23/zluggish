import { Option, Schema } from 'effect';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
Whether a rider wants the Sauce Overlay pages of this server (`/pages/*`). The opt-in is per rider,
off by default, and lives in one JSON file of the storage folder: only the riders who turned it on are
listed, so the document stays tiny and a rider who turns it off simply disappears from it.

The file is read once, lazily (the storage folder may not exist yet when the server starts) and kept
in memory; every write replaces the whole file atomically, a temp file in the same directory renamed
over the target, so a crash mid-write can never leave a half-written document behind. A missing,
unreadable, unparsable or plainly wrong document behaves like an empty one: this opt-in never breaks
a request.
*/

/** The document: player ids (as JSON keys) of the riders who opted in, each `true`. */
const decodeDocument = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean)));

export class OverlayOptIn {
  private readonly file: string;

  /** null until the file is read for the first time; never null afterwards. */
  private loaded: Set<number> | null = null;

  public constructor(storageDir: string) {
    this.file = join(storageDir, 'overlay-optin.json');
  }

  /** The enabled riders, read from the file exactly once. A value that is not `true` is not enabled. */
  private get riders(): Set<number> {
    if (this.loaded === null) {
      this.loaded = new Set<number>();

      let text = '';

      try {
        text = readFileSync(this.file, 'utf8');
      } catch {
        // a missing or unreadable file means nobody opted in
      }

      // A document that is not an object of booleans is no document at all.
      const document = Option.getOrElse(decodeDocument(text), () => ({}));

      for (const [key, value] of Object.entries(document)) {
        const playerId = Number(key);

        if (value && Number.isSafeInteger(playerId) && playerId > 0) {
          this.loaded.add(playerId);
        }
      }
    }

    return this.loaded;
  }

  /** Whether this rider opted into the Overlay pages; anything unknown is off. */
  public enabled(playerId: number): boolean {
    return this.riders.has(playerId);
  }

  /** Turns the Overlay pages of this rider on or off and rewrites the file; off removes the key. */
  public set(playerId: number, enabled: boolean): void {
    const riders = this.riders;

    if (enabled) {
      riders.add(playerId);
    } else {
      riders.delete(playerId);
    }

    const document: Record<string, true> = {};

    for (const rider of riders) {
      document[String(rider)] = true;
    }

    mkdirSync(join(this.file, '..'), { recursive: true });

    const temporary = `${this.file}.tmp`;

    writeFileSync(temporary, JSON.stringify(document, null, 2), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
