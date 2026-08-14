import { dirname, join } from "node:path";

export interface GitHubRepositoryInput {
  cloneUrl: string;
  destination: string;
  name: string;
}

const OWNER = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const REPOSITORY = "[A-Za-z0-9._-]+";
const SCP_GITHUB = new RegExp(
  `^git@github\\.com:(${OWNER})/(${REPOSITORY})(?:\\.git)?$`
);
const BARE_GITHUB = new RegExp(
  `^(?:www\\.)?github\\.com/(${OWNER})/(${REPOSITORY})(?:\\.git)?/?$`,
  "i"
);

export function githubRepositoryInput(
  input: string,
  currentWorkspace: string
): GitHubRepositoryInput | null {
  const trimmed = input.trim();
  const scp = SCP_GITHUB.exec(trimmed);
  if (scp) {
    return repositoryInput(trimmed, stripGitSuffix(scp[2]), currentWorkspace);
  }

  const bare = BARE_GITHUB.exec(trimmed);
  if (bare) {
    const owner = bare[1];
    const name = stripGitSuffix(bare[2]);
    return repositoryInput(
      `https://github.com/${owner}/${name}.git`,
      name,
      currentWorkspace
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const protocolAllowed = ["https:", "ssh:"].includes(url.protocol);
  const hostAllowed = ["github.com", "www.github.com"].includes(
    url.hostname.toLowerCase()
  );
  if (!(protocolAllowed && hostAllowed)) {
    return null;
  }
  if (url.password || (url.username && url.protocol === "https:")) {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }
  const [owner, rawName] = parts;
  const name = stripGitSuffix(rawName);
  if (
    !(
      new RegExp(`^${OWNER}$`).test(owner) &&
      new RegExp(`^${REPOSITORY}$`).test(name)
    )
  ) {
    return null;
  }
  const cloneUrl =
    url.protocol === "ssh:"
      ? `ssh://git@github.com/${owner}/${name}.git`
      : `https://github.com/${owner}/${name}.git`;
  return repositoryInput(cloneUrl, name, currentWorkspace);
}

function repositoryInput(
  cloneUrl: string,
  name: string,
  currentWorkspace: string
): GitHubRepositoryInput {
  return {
    cloneUrl,
    destination: join(dirname(currentWorkspace), name),
    name,
  };
}

function stripGitSuffix(name: string): string {
  return name.replace(/\.git$/i, "");
}
