import { Context, Effect, Layer } from 'effect';
import { RuntimeContext } from '#src/context';

const make = Effect.gen(function* () {
  const context = yield* RuntimeContext;
  const files = context.accounts.repositories.filesRepository;

  const exists = Effect.fn('FilesService.exists')(function* (path: string) {
    return files.existsSync(path);
  });

  const isFile = Effect.fn('FilesService.isFile')(function* (path: string) {
    return files.existsSync(path) && files.statSync(path).isFile();
  });

  const size = Effect.fn('FilesService.size')(function* (path: string) {
    return files.statSync(path).size;
  });

  /** Stream the inclusive byte range of path, for files too large to hold in memory. */
  const readStream = Effect.fn('FilesService.readStream')(function* (
    path: string,
    range: { start: number; end: number },
  ) {
    return files.createReadStream(path, range);
  });

  const read = Effect.fn('FilesService.read')(function* (path: string) {
    return files.readFileSync(path);
  });

  const readText = Effect.fn('FilesService.readText')(function* (path: string) {
    return files.readFileSync(path, 'utf8');
  });

  /** Write path durably; an existing file is kept unless replace is set. */
  const write = Effect.fn('FilesService.write')(function* (
    path: string,
    data: string | Uint8Array,
    replace: boolean = false,
  ) {
    files.writeDurable(path, data, replace);
  });

  return { exists, isFile, size, readStream, read, readText, write };
});

export class FilesService extends Context.Service<FilesService, Effect.Success<typeof make>>()(
  'zluggish/FilesService',
) {
  static readonly layer = Layer.effect(FilesService, make);
}
