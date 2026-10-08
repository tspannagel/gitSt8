import { RepoRef } from './types';

const dec = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const stripGit = (s: string) => s.replace(/\.git$/i, '').replace(/\/+$/, '');

/**
 * Recognizes GitHub (incl. Enterprise when `githubHosts` lists the host) and Azure DevOps remotes,
 * in HTTPS, SSH and scp-like forms. Returns null for anything else.
 */
export function parseRemoteUrl(url: string, githubHosts: string[] = []): RepoRef | null {
  const u = url.trim();
  let m: RegExpExecArray | null;

  // ---- Azure DevOps
  // https://[user@]dev.azure.com/{org}/{project}/_git/{repo}
  if ((m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i.exec(u))) {
    return azure(dec(m[1]), dec(m[2]), dec(stripGit(m[3])));
  }
  // https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
  if ((m = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)/i.exec(u))) {
    return azure(dec(m[1]), dec(m[2]), dec(stripGit(m[3])));
  }
  // git@ssh.dev.azure.com:v3/{org}/{project}/{repo}  and  {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
  if ((m = /^(?:ssh:\/\/)?[^@]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/](?:\d+\/)?v3\/([^/]+)\/([^/]+)\/([^/?#]+)/i.exec(u))) {
    return azure(dec(m[1]), dec(m[2]), dec(stripGit(m[3])));
  }

  // ---- GitHub
  const hosts = ['github.com', ...githubHosts.map(h => h.toLowerCase())];
  // https://[user@]host/owner/repo(.git)  |  ssh://git@host[:port]/owner/repo  |  git@host:owner/repo
  m =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/?#]+)/i.exec(u) ||
    /^[^@/]+@([^:/]+):([^/]+)\/([^/?#]+)$/i.exec(u);
  if (m && hosts.includes(m[1].toLowerCase())) {
    const host = m[1].toLowerCase();
    const owner = m[2];
    const repo = stripGit(m[3]);
    return { provider: 'github', host, owner, repo, webUrl: `https://${host}/${owner}/${repo}` };
  }
  return null;
}

function azure(org: string, project: string, repo: string): RepoRef {
  const e = encodeURIComponent;
  return {
    provider: 'azure',
    host: 'dev.azure.com',
    owner: org,
    project,
    repo,
    webUrl: `https://dev.azure.com/${e(org)}/${e(project)}/_git/${e(repo)}`,
  };
}

/** Human-readable name, e.g. "owner/repo" or "org/project/repo". */
export function repoLabel(r: RepoRef): string {
  return r.provider === 'azure' ? `${r.owner}/${r.project}/${r.repo}` : `${r.owner}/${r.repo}`;
}
