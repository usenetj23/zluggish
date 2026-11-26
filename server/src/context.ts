import { Context } from 'effect';
import type { ResolvedConfig } from '#src/config/index';
import type { AccountsService } from '#src/services/auth.service';
import type { Bridge } from '#src/services/chat-bridge.service';
import type { SessionsService } from '#src/services/browser-session.service';
import type { Profiles } from '#src/repositories/profile.repository';
import type { SettingsStore } from '#src/repositories/settings.repository';
import type { World } from '#src/world/state';

export interface RepositoryContext {
  bridges?: Array<Bridge>;
  config: ResolvedConfig;
  configPath?: string | undefined;
  accounts: AccountsService['Service'];
  sessions: SessionsService['Service'];
  world: World;
  settings: SettingsStore;
  profiles: Profiles;
  assets: string;
  tokens: { access: string; refresh: string; id: string };
}

export class RuntimeContext extends Context.Service<RuntimeContext, RepositoryContext>()('zluggish/RuntimeContext') {}
