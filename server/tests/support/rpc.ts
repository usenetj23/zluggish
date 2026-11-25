import { Schema } from 'effect';

/** The `{ success, value }` envelope of one widget RPC answer, its value decoded with `value`. */
export const answerOf = async <S extends Schema.Top & { readonly DecodingServices: never }>(
  response: Response,
  value: S,
) => Schema.decodeUnknownSync(Schema.Struct({ success: Schema.Boolean, value }))(await response.json());
