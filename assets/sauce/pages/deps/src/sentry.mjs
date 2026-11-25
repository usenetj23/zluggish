// Zluggish stub, not part of Sauce for Zwift.
// Sauce's widget pages import this module to report their errors to Sauce's own error tracker. Zluggish
// does not ship that tracker, so nothing here can leave this server; `Common.enableSentry()` never calls
// `init` either, because the server answers `getSentryConfig` with nothing.
export function init() {}

export function addBreadcrumb() {}
