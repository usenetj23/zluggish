import type { AppRuntime } from '#src/layers';
import type { RepositoryContext } from '#src/context';
import type { User } from '#src/repositories/accounts.repository';
import type { BrowserSession } from '#src/services/browser-session.service';

export interface Runtime extends RepositoryContext {
  effects: AppRuntime;
}

export type HttpRuntime = Omit<Runtime, 'accounts' | 'sessions' | 'profiles' | 'settings'>;

export type RuntimeEnv = {
  Variables: {
    requestId: string;
    user: User | null;
    browser: BrowserSession;
    browserId: string;
  };
};
