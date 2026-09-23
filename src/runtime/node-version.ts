export function assertSupportedNode(version: string): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) throw new Error(`Unable to parse Node.js version '${version}'`);
  const major = Number(match[1]);
  if (major < 24) throw new Error(`Node.js 24 or newer is required; found ${version}`);
}
