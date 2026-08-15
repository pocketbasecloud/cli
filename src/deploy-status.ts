/**
 * What a failed deployment's `subStatus` means, in a sentence.
 *
 * When a deploy fails, the request that failed belonged to a platform-side
 * hook — there is no response for the CLI to read. The reason survives only as
 * a `subStatus` on the record, which is why the wait loop reports it: without
 * this the CLI could say no more than "my-app is error", and the user's next
 * move was to open the portal, which said the same thing.
 *
 * The vocabulary is the platform's (`PocketBaseService`, `BackendService`,
 * `FrontendService`) and is mirrored in the portal's
 * `portal_v2/src/utils/deploymentStatus.ts` — two runtimes, no shared package,
 * so the two maps are kept in step by hand. Progress sub-statuses are absent on
 * purpose: this only ever explains a failure.
 */

const FAILURE_REASONS: Record<string, string> = {
  agentUnreachable:
    "the compute stopped responding, so the deploy could not be confirmed — it may still have finished; check again before retrying",
  deploymentFailed:
    "the compute rejected the deployment — check the logs with `pb cloud logs`",
  setupFailed: "the compute for this deployment could not be reached",
  failedToDownloadZip:
    "the uploaded archive could not be read — rebuild and deploy again",
  noZipFile: "no archive was uploaded, so there was nothing to deploy",
  fileUploadFailed:
    "the files could not be written to the running instance, which is still serving the previous version",
  archiveMissingPbDirs:
    "the archive holds no pb_hooks, pb_migrations or pb_public directory at its root, so nothing was installed — the instance is untouched and still running",
  hooksNotInstallable:
    "a hook file could not be installed — hooks must be .js or .json files directly under pb_hooks/, not in a subdirectory; nothing was installed and the instance is still running",
  noAssignedPort: "no port could be assigned on the compute — contact support",
  computeFull: "your compute is full — add-ons coming soon",
  noServerAvailable:
    "no compute was available to host it — if you chose a region, try again without one",
  missingCredentials:
    "the admin email and password were missing, so the instance could not be created",
  incompleteRecord:
    "a required field was missing from the deployment record — contact support",
  invalidServerAssignment:
    "it was pointed at compute that isn't yours — create it again and pick your own compute",
};

/**
 * The reason a deployment failed, or `undefined` when the platform recorded
 * none we recognise — callers say only what they know rather than guessing.
 */
export function describeSubStatus(
  subStatus: string | undefined | null,
): string | undefined {
  if (!subStatus) return undefined;
  return FAILURE_REASONS[subStatus];
}
