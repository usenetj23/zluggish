import { t } from '#src/i18n/index';
import { rpcError, value } from '#src/http/widget-api/rpc';
import type { RpcCall, RpcHandlers } from '#src/http/widget-api/rpc';
import type { WidgetDeps } from '#src/http/widget-api/deps';
import { installModZip } from '#src/world/mod-installer';
import { githubRepoOf, parseGitHubInput } from '#src/world/mod-store';
import type { StoreMod } from '#src/world/mod-store';
import { isSafeId } from '#src/world/mods-core';
import { RateLimit } from '#src/world/rate-limit';

type ModDeps = Pick<WidgetDeps, 'isAdministrator' | 'log' | 'mods' | 'modStore'>;

type Status = 400 | 403 | 409 | 429 | 500 | 502;

/** A failed call in the envelope `makeRPCError` of the pages reads. */
function refuse(call: RpcCall, name: string, message: string, status: Status) {
  return call.c.json({ success: false, error: rpcError(name, message) }, status);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The registry raises these for a mod id or a review the caller got wrong; anything else is ours. */
function registryRefusal(call: RpcCall, reason: string) {
  if (reason === t('mod_registry_unknown_mod')) {
    return refuse(call, 'ArgumentError', t('widget_mod_unknown'), 400);
  }

  if (reason.startsWith('invalid mod')) {
    return refuse(call, 'ArgumentError', reason, 400);
  }

  if (reason === t('mod_registry_changed_since_review')) {
    return refuse(call, 'ArgumentError', t('widget_mod_changed'), 409);
  }

  return null;
}

/** A plain string argument of `min` to `max` characters without control characters, or null. */
function textArgument(argument: unknown, min: number, max: number): string | null {
  return typeof argument === 'string' &&
    argument.length >= min &&
    argument.length <= max &&
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused here
    !/[\u{0}-\u{1F}\u{7F}]/u.test(argument)
    ? argument
    : null;
}

/** What the pages send for an argument they do not give. */
const absentArguments: ReadonlySet<unknown> = new Set([undefined, null, '']);

/** An optional string argument: the v1 transport turns `undefined` into `null` and a blank field of the
Overlay settings page sends `''`, all three meaning "not given". A present argument of the wrong type
is refused as null. */
function optionalText(argument: unknown, max: number): string | undefined | null {
  if (absentArguments.has(argument)) {
    return undefined;
  }

  return textArgument(argument, 1, max);
}

/** The list of `getAvailableMods`, in the shape the Overview mod panel reads. */
function listMods(deps: ModDeps, call: RpcCall) {
  return call.c.json(
    value(
      deps.mods.list().map((entry) => ({
        id: entry.id,
        manifest: entry.manifest,
        hash: entry.hash,
        packed: false,
        restartRequired: false,
        status: entry.status === 'active' ? 'active' : undefined,
        isNew: false,
        enabled: entry.enabled,
        network: entry.network,
        error: entry.error,
        changed: entry.status === 'changed',
      })),
    ),
  );
}

/** What the store offers, without the release URLs: `installMod` fetches through the store dep. */
function storeListing(mods: Array<StoreMod>) {
  return mods.map((mod) => ({
    id: mod.id,
    name: mod.name,
    description: mod.description,
    tags: mod.tags,
    homeURL: mod.homeURL,
    logoURL: mod.logoURL,
    releases: mod.releases.map((release) => ({
      version: release.version,
      updated: release.updated,
      size: release.size,
      minVersion: release.minVersion,
      notes: release.notes,
      hash: release.hash,
    })),
  }));
}

/**
The mod calls of the widget API: listing the mods of `storage/mods`, enabling one after its files were
reviewed, granting it the network, removing it, browsing the Sauce mod store and installing a mod from
the store, from a GitHub repository or from a ZIP archive.

Every change of what this server loads and runs is for an administrator of this site only, from a
request that says it comes from here. One mount is one running server, so at most one install runs at
a time and an administrator installs at most five mods a minute: both guards belong to the mount.
*/
export function modRpcs(deps: ModDeps): RpcHandlers {
  let installing = false;
  const installLimit = new RateLimit(5, 60_000);

  /** The cross-site and administrator checks of every call that changes the mods. */
  const guard = (call: RpcCall) => {
    if (call.crossSite()) {
      return refuse(call, 'ForbiddenError', t('widget_cross_site_refused'), 403);
    }

    return deps.isAdministrator(call.c) ? null : refuse(call, 'ForbiddenError', t('widget_admin_required'), 403);
  };

  /** Runs one install under the rate limit and the one-at-a-time rule. */
  const exclusive = async (call: RpcCall, install: () => Response | Promise<Response>) => {
    if (!installLimit.allow(call.viewer)) {
      return refuse(call, 'RateLimitError', t('widget_install_rate_limited'), 429);
    }

    if (installing) {
      return refuse(call, 'BusyError', t('widget_install_busy'), 409);
    }

    installing = true;

    try {
      return await install();
    } finally {
      installing = false;
    }
  };

  /** Lays one archive under the mods root; a ZIP or manifest the installer refuses is the caller's. */
  const installArchive = (call: RpcCall, archive: Buffer, answer: Readonly<Record<string, string>>, source: string) => {
    try {
      const result = installModZip(deps.mods.root, archive);

      deps.log('widget_api.mod', 'Mod installed', { id: result.id, replaced: result.replaced, source });

      return call.c.json(value({ id: result.id, replaced: result.replaced, skipped: result.skipped, ...answer }));
    } catch (error) {
      if (!(error instanceof Error)) {
        deps.log('widget_api.failed', 'Installing a mod failed', { error: String(error) });

        return refuse(call, 'InternalError', t('widget_mod_install_failed'), 500);
      }

      return refuse(call, 'ArgumentError', t('widget_mod_archive_invalid', { reason: error.message }), 400);
    }
  };

  /** The store file server is gone (`mod-api.sauce.llc` no longer resolves): install from the GitHub
  repository the store lists for the mod, when it lists one. */
  const installFromListedRepository = async (call: RpcCall, storeId: string, reason: string) => {
    const listed = await deps.modStore.directory().catch(() => []);
    const found = listed.find((entry) => entry.id === storeId);
    const repo = found ? githubRepoOf(found) : null;

    if (repo === null) {
      deps.log('widget_api.failed', 'Downloading a mod failed', { storeId, error: reason });

      return refuse(call, 'UpstreamError', t('widget_mod_store_unreachable'), 502);
    }

    try {
      const { archive } = await deps.modStore.downloadGitHub(repo);

      return installArchive(call, archive, { name: found?.name ?? storeId, source: 'github', repo }, 'store-github');
    } catch (error) {
      deps.log('widget_api.failed', 'Downloading a mod failed', { storeId, repo, error: messageOf(error) });

      return refuse(call, 'UpstreamError', messageOf(error), 502);
    }
  };

  const installFromStore = async (call: RpcCall, storeId: string, version: string | undefined) => {
    let download: Awaited<ReturnType<ModDeps['modStore']['download']>>;

    try {
      download = await deps.modStore.download(storeId, version);
    } catch (error) {
      const reason = messageOf(error);

      // A store id or version the directory does not offer is the caller's mistake; a release that
      // did not arrive intact is the store's.
      if (reason === t('mod_store_unknown_store_mod') || reason === t('mod_store_unknown_release')) {
        return refuse(call, 'ArgumentError', reason, 400);
      }

      if (reason === t('mod_store_hash_mismatch') || reason === t('mod_store_size_mismatch')) {
        deps.log('widget_api.failed', 'Downloading a mod failed', { storeId, error: reason });

        return refuse(call, 'UpstreamError', reason, 502);
      }

      if (reason === t('mod_store_host_not_allowed') || reason.startsWith('download')) {
        return installFromListedRepository(call, storeId, reason);
      }

      deps.log('widget_api.failed', 'Downloading a mod failed', { storeId, error: reason });

      return refuse(call, 'InternalError', t('widget_mod_download_failed'), 500);
    }

    return installArchive(
      call,
      download.archive,
      { version: download.release.version, name: download.mod.name },
      'store',
    );
  };

  const installFromGitHub = async (call: RpcCall, repo: string, ref: string | undefined) => {
    let download: Awaited<ReturnType<ModDeps['modStore']['downloadGitHub']>>;

    try {
      download = await deps.modStore.downloadGitHub(repo, ref);
    } catch (error) {
      const reason = messageOf(error);

      if (reason === t('mod_store_invalid_repository') || reason === t('mod_store_invalid_ref')) {
        return refuse(call, 'ArgumentError', reason, 400);
      }

      deps.log('widget_api.failed', 'Downloading a mod failed', { repo, error: reason });

      return reason === t('mod_store_host_not_allowed') || reason.startsWith('download')
        ? refuse(call, 'UpstreamError', reason, 502)
        : refuse(call, 'InternalError', t('widget_mod_download_failed'), 500);
    }

    return installArchive(call, download.archive, { repo: download.repo, ref: download.ref }, 'github');
  };

  /** One registry change, its refusals mapped to the RPC errors the pages show. */
  const change = <T>(call: RpcCall, failure: string, apply: () => T) => {
    try {
      return call.c.json(value(apply()));
    } catch (error) {
      const reason = messageOf(error);
      const refusal = registryRefusal(call, reason);

      if (refusal) {
        return refusal;
      }

      deps.log('widget_api.failed', 'Changing a mod failed', { error: reason });

      return refuse(call, 'InternalError', failure, 500);
    }
  };

  /** The mod id of argument 0, after the guard; a refusal when either fails. */
  const modId = (call: RpcCall) => {
    const refusal = guard(call);

    if (refusal) {
      return { refusal };
    }

    const id = typeof call.args[0] === 'string' && isSafeId(call.args[0]) ? call.args[0] : null;

    return id === null ? { refusal: refuse(call, 'ArgumentError', t('widget_mod_id_required'), 400) } : { id };
  };

  return {
    getAvailableMods: (call) => listMods(deps, call),

    getAvailableModsV1: (call) => listMods(deps, call),

    setModEnabled: (call) => {
      const { id, refusal } = modId(call);

      if (refusal) {
        return refusal;
      }

      const enabled = call.args[1];

      if (typeof enabled !== 'boolean') {
        return refuse(call, 'ArgumentError', t('widget_mod_enabled_boolean'), 400);
      }

      // Enabling pins the files the administrator reviewed: the page hands back the hash it showed.
      const expectedHash = typeof call.args[2] === 'string' && call.args[2].length > 0 ? call.args[2] : undefined;

      if (enabled && expectedHash === undefined) {
        return refuse(call, 'ArgumentError', t('widget_mod_hash_required'), 400);
      }

      return change(call, t('widget_mod_change_failed'), () => {
        const entry = deps.mods.setEnabled(id, enabled, expectedHash);

        deps.log('widget_api.mod', 'Mod enabled', { id, enabled });

        return { id, enabled: entry.enabled, status: entry.status };
      });
    },

    setModNetwork: (call) => {
      const { id, refusal } = modId(call);

      if (refusal) {
        return refusal;
      }

      const allowed = call.args[1];

      if (typeof allowed !== 'boolean') {
        return refuse(call, 'ArgumentError', t('widget_mod_network_boolean'), 400);
      }

      return change(call, t('widget_mod_change_failed'), () => {
        deps.mods.setNetwork(id, allowed);
        deps.log('widget_api.mod', 'Mod network permission', { id, allowed });

        return { id, network: allowed };
      });
    },

    removeMod: (call) => {
      const { id, refusal } = modId(call);

      if (refusal) {
        return refusal;
      }

      return change(call, t('widget_mod_remove_failed'), () => {
        deps.mods.remove(id);
        deps.log('widget_api.mod', 'Mod removed', { id });

        return null;
      });
    },

    getModStore: async (call) => {
      // The store directory is what an administrator browses before installing.
      if (!deps.isAdministrator(call.c)) {
        return refuse(call, 'ForbiddenError', t('widget_admin_required'), 403);
      }

      try {
        return call.c.json(value(storeListing(await deps.modStore.directory())));
      } catch (error) {
        deps.log('widget_api.failed', 'Reading the mod store failed', { error: messageOf(error) });

        return refuse(call, 'UpstreamError', t('widget_mod_store_unreadable'), 502);
      }
    },

    installMod: async (call) => {
      const refusal = guard(call);

      if (refusal) {
        return refusal;
      }

      const storeId = textArgument(call.args[0], 1, 100);
      // An absent version is the newest release.
      const version = optionalText(call.args[1], 50);

      if (storeId === null || version === null) {
        return refuse(call, 'ArgumentError', t('widget_mod_store_id_required'), 400);
      }

      return exclusive(call, () => installFromStore(call, storeId, version));
    },

    installModFromGitHub: async (call) => {
      const refusal = guard(call);

      if (refusal) {
        return refusal;
      }

      // Whatever the administrator pasted: `owner/name` or a GitHub link, which may carry the ref
      // itself; an explicit ref argument wins over the one inside the link.
      const input = textArgument(call.args[0], 3, 400);
      const ref = optionalText(call.args[1], 100);
      const parsed = input === null ? null : parseGitHubInput(input);

      if (parsed === null || ref === null) {
        return refuse(call, 'ArgumentError', t('widget_mod_github_required'), 400);
      }

      return exclusive(call, () => installFromGitHub(call, parsed.repo, ref ?? parsed.ref));
    },

    installModFromZip: async (call) => {
      const refusal = guard(call);

      if (refusal) {
        return refusal;
      }

      // 24 MB of base64, an archive of about 18 MB; a longer string is refused before it is decoded.
      // The body limit of the web app is raised for this one call (see `web-app.ts`).
      const zip = typeof call.args[0] === 'string' && call.args[0].length <= 24 * 1024 * 1024 ? call.args[0] : null;

      if (zip === null) {
        return refuse(call, 'ArgumentError', t('widget_mod_archive_too_large'), 400);
      }

      return exclusive(call, () => {
        const archive = Buffer.from(zip, 'base64');

        return archive.length === 0
          ? refuse(call, 'ArgumentError', t('widget_mod_archive_required'), 400)
          : installArchive(call, archive, { source: 'zip' }, 'zip');
      });
    },
  };
}
