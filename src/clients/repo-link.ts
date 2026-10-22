import type { ICloudClient } from "./cloud.ts";

export type RepoLink = {
  repoFullName: string;
  branch: string;
  autoDeploy?: boolean;
};

export async function linkedRepository(
  client: ICloudClient,
  pocketbaseId: string,
): Promise<RepoLink | null> {
  try {
    const res = await client.ext("/api/github/links", undefined, {
      method: "GET",
      query: { resourceKind: "pocketbases", resourceId: pocketbaseId },
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const body = await res.json().catch(() => null) as
      | { data?: RepoLink | null }
      | null;
    const link = body?.data;
    return link?.repoFullName && link.autoDeploy !== false ? link : null;
  } catch {
    return null;
  }
}

export function linkedWarning(name: string, link: RepoLink): string {
  return `${name} deploys from ${link.repoFullName} (${link.branch}). The next push there replaces what you change here. To keep it, commit it to the repository, or use Push to GitHub on the instance's Code page.`;
}

export type RepositoryResult =
  | { status: "unchanged" }
  | { status: "committed"; repo: string; branch: string; sha: string }
  | {
    status: "pullRequest";
    repo: string;
    url: string;
    reason: "review" | "conflict";
    paths: string[];
  }
  | { status: "failed"; repo: string; error: string };

export function repositoryLine(
  repository: RepositoryResult | undefined,
  what: string,
): string | null {
  if (!repository || repository.status === "unchanged") return null;
  if (repository.status === "committed") {
    return `Committed the ${what} to ${repository.repo} (${repository.branch}) as ${
      repository.sha.slice(0, 7)
    }.`;
  }
  if (repository.status === "pullRequest") {
    const why = repository.reason === "review"
      ? ""
      : repository.paths.length > 0
      ? ` because ${repository.repo} also changed ${
        repository.paths.join(", ")
      }`
      : ` because ${repository.repo} has commits that are not deployed yet`;
    return `Opened a pull request for the ${what}${why}: ${repository.url}. Merge it to keep the ${what}; a push before then replaces it.`;
  }
  return `Not committed to ${repository.repo}: ${repository.error}. The next push there will replace the ${what}.`;
}
