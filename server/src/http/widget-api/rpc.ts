import { t } from '#src/i18n/index';
import type { Context } from 'hono';
import type { WebEnv } from '#src/http/web-app';

/** One RPC dispatch: the handler of a single method name is handed the request, its arguments and
the viewer its session belongs to, plus the `crossSite` check the handler itself needs. */
export interface RpcCall {
  c: Context<WebEnv>;
  name: string;
  args: Array<unknown>;
  viewer: number;
  crossSite: () => boolean;
}

export type RpcHandler = (call: RpcCall) => Response | Promise<Response>;

export type RpcHandlers = Readonly<Record<string, RpcHandler>>;

/** The handler registered for `name`, or `undefined` when none is: only an own property of the
registry counts, so an inherited `constructor` or `toString` never answers a call. */
export function handlerFor(handlers: RpcHandlers, name: string): RpcHandler | undefined {
  return Object.hasOwn(handlers, name) ? handlers[name] : undefined;
}

/** The `error` of a failed RPC call, in the shape the browser client reads: `makeRPCError` in
`assets/sauce/pages/src/common.mjs` destructures `{ name, message, stack }` out of it, so a plain
string there would surface to the page as `Error: undefined: undefined`. We have no server-side stack
to hand over, so `stack` stays empty. */
export function rpcError(name: string, message: string) {
  return { name, message, stack: '' };
}

/** The envelope of the browser RPC transport: a failed call carries only its `error`. */
export function notImplemented(name: string) {
  return { success: false, error: rpcError('NotImplementedError', t('widget_not_implemented', { value1: name })) };
}

/** The answer to a request whose session is gone: the widget pages read `env.error` and show its
message, so an anonymous or expired rider is turned away before a view or a world packet is read. */
export function signIn(c: Context<WebEnv>) {
  return c.json({ message: t('widget_sign_in_first') }, 401);
}

/** The envelope of a successful call. */
export function value(of: unknown) {
  return { success: true, value: of };
}

/** The rider a call asks about: the watched one for `self`, `watching` or no argument at all. */
export function watchedRider(argument: unknown): number | 'self' | 'watching' {
  if (argument === undefined) {
    return 'self';
  }

  if (argument === 'self' || argument === 'watching') {
    return argument;
  }

  if (typeof argument === 'number') {
    return argument;
  }

  return typeof argument === 'string' && argument.trim() !== '' && Number.isFinite(Number(argument))
    ? Number(argument)
    : // eslint-disable-next-line unicorn/prefer-global-number-constants -- oxlint's prefer-number-properties asks for Number.NaN
      Number.NaN;
}

/** Starting a lap, resetting a ride and sending a chat message change the world. The Sauce pages
call them as POSTs of this site behind the app's CSRF token; an outside page must still not be
able to fire them, so a request that says where it comes from has to say it comes from here:
this check is the second line of defence behind that middleware. Three signals
say so: `Sec-Fetch-Site` (a browser that knows Fetch Metadata), `Origin` (a fetch or a CORS-mode
navigation) and, when both of those are absent, `Referer` (a request from an older
browser, which sends neither of the first two). A request with none of the three passes as a
non-browser caller: a script or tool calling with the session cookie. */
export function isCrossSite(
  c: Context<WebEnv>,
  originAllowed: (c: Context<WebEnv>) => boolean,
  refererAllowed: (c: Context<WebEnv>) => boolean,
): boolean {
  const site = c.req.header('Sec-Fetch-Site');

  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return true;
  }

  if (!originAllowed(c)) {
    return true;
  }

  return site === undefined && c.req.header('Origin') === undefined && !refererAllowed(c);
}
