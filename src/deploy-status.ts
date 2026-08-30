const FAILURE_REASONS: Record<string, string> = {
  agentUnreachable:
    "the compute stopped responding, so the deploy could not be confirmed — it may still have finished; check again before retrying",
  deploymentFailed:
    "the compute rejected the deployment — check the logs with `pbc logs`",
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

export function describeSubStatus(
  subStatus: string | undefined | null,
): string | undefined {
  if (!subStatus) return undefined;
  return FAILURE_REASONS[subStatus];
}
