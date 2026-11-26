import type { AppRuntime, AppServices } from '#src/layers';
import type { Effect } from 'effect';
import type { Context, Env, Hono } from 'hono';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export type EffectHandler<E extends Env, P extends string> = (
  c: Context<E, P>,
) => Effect.Effect<Response | Promise<Response>, unknown, AppServices>;

/** Register Hono routes whose handlers are Effects. Each runs with the application services, and a
failure reaches `app.onError` as the original error.
*/
export function effectRoutes<E extends Env>(app: Hono<E>, runtime: { readonly effects: AppRuntime }) {
  const on = <P extends string>(method: Method | Array<Method>, path: P | Array<P>, handler: EffectHandler<E, P>) =>
    app.on(method, [path].flat(), (c) =>
      // SAFETY: Hono matched one of `path`, so the context carries that path's parameters.
      runtime.effects.runPromise(handler(c as Context<E, P>)),
    );

  const route =
    (method: Method) =>
    <P extends string>(path: P, handler: EffectHandler<E, P>) =>
      on(method, path, handler);

  return {
    on,
    get: route('GET'),
    post: route('POST'),
    put: route('PUT'),
    delete: route('DELETE'),
    patch: route('PATCH'),
  };
}
