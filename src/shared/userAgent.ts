/**
 * One user agent for every request PatchPilot makes, on the server and inside
 * the Android app. Lives here (not in config.ts) because config.ts touches the
 * filesystem and the phone build must be able to import this.
 */

export const PROJECT_URL = 'https://github.com/mob5824m-wq/PatchPilot';

export function buildUserAgent(version: string): string {
  return `PatchPilot/${version} (+${PROJECT_URL})`;
}
