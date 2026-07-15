export const pearConfig = {
  appName: "My execution app",
  domainId: "starter",
  actorId: "demo-user",
  apiBaseUrl: import.meta.env.VITE_PEAR_API_URL || window.location.origin,
} as const;

export function getPearContext() {
  return {
    actorId: pearConfig.actorId,
    roles: ["developer"],
  };
}
