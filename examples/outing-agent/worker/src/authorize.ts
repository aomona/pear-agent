import { allowAllAuthorize, AuthorizationError, type AuthorizeFn } from "@pear-agent/cloudflare";

/**
 * Demo authorization: allow all unless claim `deny: true` is set.
 * Production hosts should replace this with real authz.
 */
export const authorize: AuthorizeFn = async (operation, context) => {
  if (context.claims["deny"] === true) {
    throw new AuthorizationError("Denied by claim");
  }
  await allowAllAuthorize(operation, context);
};
